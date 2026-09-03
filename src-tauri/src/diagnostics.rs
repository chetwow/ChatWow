//! Where a crash leaves a trace.
//!
//! Nothing this app knew used to survive it. Rust's diagnostics went to
//! stderr, which under `npm run tauri dev` means a terminal you may have
//! closed and in a bundled `.app` means nowhere at all; a panic inside a
//! spawned task was captured by a `JoinHandle` nobody awaits, so its socket
//! simply stopped with the window still up; and an exception in the webview
//! stayed in a devtools console nobody had open. So there is one log file,
//! in the OS's own log directory, holding what both halves had to say.
//!
//! What it must never hold is the two things worth keeping out of a file the
//! user might paste into an issue: an access token, and the text of anybody's
//! messages. Log the shape of what happened -- which channel, which account's
//! login, which url failed -- and not its contents.
//!
//! Platform directories, from `TargetKind::LogDir`:
//!   macOS    ~/Library/Logs/io.github.chetwow.chatwow/
//!   Windows  %LOCALAPPDATA%\io.github.chetwow.chatwow\logs\
//!   Linux    ~/.local/share/io.github.chetwow.chatwow/logs/

use std::future::Future;
use std::panic;

use futures_util::FutureExt;
use log::LevelFilter;
use tauri::Runtime;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// The plugin's own default is 40KB, which a busy session fills before it gets
/// to whatever you opened the file for. Three files at 5MB is a few sessions
/// of history and still nothing anyone would notice on disk.
const MAX_LOG_BYTES: u128 = 5_000_000;
const LOG_FILES_KEPT: usize = 3;

/// The file everything lands in, `.log` appended by the plugin. Named rather
/// than left to default so the rotated copies are recognizable beside it.
const LOG_FILE: &str = "chatwow";

/// Set `CHATWOW_LOG=debug` to turn the volume up for one run. Anything
/// `log::LevelFilter` parses works -- off, error, warn, info, debug, trace.
const LEVEL_ENV: &str = "CHATWOW_LOG";

/// How much of our own is written down. Info is the level at which the file
/// reads as a story -- what was joined, what reconnected, what was refused --
/// without the per-message noise that would bury it.
const DEFAULT_LEVEL: LevelFilter = LevelFilter::Info;

fn level() -> LevelFilter {
    std::env::var(LEVEL_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_LEVEL)
}

/// The logger, as a Tauri plugin.
///
/// The level is set twice on purpose: everything defaults to `Warn`, and only
/// this app's own modules and the webview get the chosen level. Otherwise
/// `CHATWOW_LOG=debug` is unusable -- rustls, hyper and tungstenite between
/// them say more per second at debug than a whole session of ours does.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::LogDir { file_name: Some(LOG_FILE.into()) }),
            // Kept for `npm run tauri dev`, where the terminal is still the
            // fastest place to read: the file is for the run you weren't
            // watching.
            Target::new(TargetKind::Stdout),
        ])
        .level(LevelFilter::Warn)
        .level_for("chatwow_lib", level())
        // Everything the frontend sends over arrives under this target.
        .level_for(tauri_plugin_log::WEBVIEW_TARGET, level())
        .max_file_size(MAX_LOG_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_FILES_KEPT))
        // The reader's own clock: a log is read against "it died around
        // half seven", and UTC makes that a subtraction.
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

/// Write a panic down before the default hook has it.
///
/// Rust's own hook prints to stderr and nothing else, so this is the whole
/// reason a panic leaves any record at all. It chains rather than replaces:
/// under `tauri dev` the familiar message still appears in the terminal.
///
/// Install this *after* the plugin, or the logger it writes to doesn't exist
/// yet and the first panic is the one that goes missing.
pub fn install_panic_hook() {
    let default_hook = panic::take_hook();

    panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed").to_string();
        // `force_capture`, not `capture`: nobody who double-clicked the app
        // set `RUST_BACKTRACE`, and a panic with no frames under it barely
        // narrows anything down.
        let backtrace = std::backtrace::Backtrace::force_capture();

        log::error!("panic on thread {name}: {info}\n{backtrace}");
        default_hook(info);
    }));
}

/// Spawn one of the app's long-lived tasks so that its ending is noticed.
///
/// `tauri::async_runtime::spawn` hands back a `JoinHandle`, and a panic inside
/// the task is delivered *to that handle* -- which nothing awaits, so the task
/// dies in silence and the only symptom is that whatever it was doing stops
/// happening. This catches the unwind and writes down which task it was; the
/// panic hook above has already written why.
///
/// Nothing is restarted. Every task here already has its own retry loop for
/// the failures it expects, so reaching this means an assumption broke rather
/// than a network did, and running it again on state it may have left half
/// written is a worse answer than a line in the log.
pub fn supervise<F>(name: impl Into<String>, task: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let name = name.into();

    tauri::async_runtime::spawn(async move {
        match panic::AssertUnwindSafe(task).catch_unwind().await {
            Ok(()) => log::debug!("{name}: finished"),
            Err(_) => log::error!("{name}: stopped -- it panicked"),
        }
    });
}

/// The first line of every run, so a file that has rotated still says which
/// build wrote it and on what.
pub fn log_launch() {
    log::info!(
        "chatwow {} starting on {} {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_comes_from_the_environment_or_falls_back() {
        // Parsed by `log` itself, so this is really checking that an
        // unreadable value is ignored rather than taken as "off".
        assert_eq!("debug".parse::<LevelFilter>().unwrap(), LevelFilter::Debug);
        assert_eq!("WARN".parse::<LevelFilter>().unwrap(), LevelFilter::Warn);
        assert!("chatty".parse::<LevelFilter>().is_err());
    }

    #[test]
    fn nothing_is_kept_indefinitely() {
        // A log that can grow without bound is a bug report nobody can attach
        // and a disk nobody expected to fill.
        assert!(MAX_LOG_BYTES * LOG_FILES_KEPT as u128 <= 20_000_000);
    }
}
