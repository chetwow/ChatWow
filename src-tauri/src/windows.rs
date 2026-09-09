//! Chat windows share connections and tabs, but own their layout and lifetime.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewWindow, WebviewWindowBuilder};

use crate::{settings::Preferences, Shared};

/// Membership lives with tabs/settings; native bounds live in window-state's cache.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Session {
    next_id: u64,
    layouts: HashMap<String, Value>,
}

const LOCAL_PREFERENCES: &[&str] = &[
    "splitLayout",
    "splitRatio",
    "splitIndex",
    "paneLayout",
    "paneChatZoom",
    "chatZoom",
    "zoomAllSplits",
    "alwaysOnTop",
    "muted",
];
const EVENTS: &[&str] = &[
    "chat://pins",
    "chat://messages",
    "chat://status",
    "chat://clear",
    "chat://channel-ready",
    "chat://emote-set",
    "chat://seventv-badges",
    "chat://assets",
    "chat://role",
    "chat://auth",
    "chat://live",
    "update://state",
    "chat://channel-avatars",
    "chat://tabs",
    "chat://preferences",
    "window://activate-tab",
    "window://close-request",
];

#[derive(Clone, Serialize)]
pub struct Event {
    sequence: u64,
    name: String,
    payload: Value,
}

#[derive(Clone, Deserialize)]
pub struct Snapshot {
    data: Value,
    cursor: u64,
}

#[derive(Default)]
struct Journal {
    sequence: u64,
    events: VecDeque<Event>,
    pending: HashMap<String, Snapshot>,
}

#[derive(Default)]
pub struct Windows {
    next: AtomicU64,
    pub quitting: AtomicBool,
    pub preference_updates: Mutex<()>,
    loaded: Mutex<HashSet<String>>,
    placements: Mutex<HashMap<String, OpeningPlacement>>,
    journal: Mutex<Journal>,
    layouts: Mutex<HashMap<String, Value>>,
    closing: Mutex<HashSet<String>>,
}

fn local_preferences(value: &Value) -> Value {
    Value::Object(
        LOCAL_PREFERENCES
            .iter()
            .filter_map(|key| value.get(*key).map(|value| ((*key).into(), value.clone())))
            .collect(),
    )
}

fn window_id(label: &str) -> Option<u64> {
    label
        .strip_prefix("chat-")?
        .parse::<u64>()
        .ok()
        .filter(|id| *id < u64::MAX)
}

impl Windows {
    pub fn session(&self) -> Session {
        Session {
            next_id: self.next.load(Ordering::Relaxed),
            layouts: self
                .layouts
                .lock()
                .iter()
                .map(|(label, local)| (label.clone(), local_preferences(local)))
                .collect(),
        }
    }

    /// Older multiwindow builds saved tab owners without a window registry. Keep
    /// those tabs in windows too, using inherited defaults for the missing layout.
    pub fn load_session(
        &self,
        saved: Session,
        tabs: &mut [crate::settings::Tab],
        defaults: &Preferences,
    ) {
        let mut layouts: HashMap<_, _> = saved
            .layouts
            .into_iter()
            .filter(|(label, _)| window_id(label).is_some())
            .collect();
        for tab in tabs {
            if window_id(&tab.window_label).is_some() {
                layouts.entry(tab.window_label.clone()).or_insert_with(|| {
                    json!({
                        "paneLayout": {"root": {"kind": "pane", "id": 0}, "tabPanes": {}},
                        "paneChatZoom": {}, "splitLayout": "none"
                    })
                });
            } else {
                tab.window_label = crate::settings::main_window();
            }
        }
        let base = serde_json::to_value(defaults).expect("preferences serialize");
        for (label, local) in &mut layouts {
            *local = local_preferences(local);
            let mut merged = base.clone();
            for (key, value) in local.as_object().expect("local preferences object") {
                merged[key] = value.clone();
            }
            if serde_json::from_value::<Preferences>(merged).is_err() {
                log::warn!("invalid saved preferences for {label}; using main window defaults");
                *local = json!({});
            }
        }
        let next = layouts
            .keys()
            .filter_map(|label| window_id(label))
            .map(|id| id + 1)
            .max()
            .unwrap_or(0)
            .max(saved.next_id);
        self.next.store(next, Ordering::Relaxed);
        // Retain startup events, including readiness/history arriving before a
        // restored webview has installed its listener. An empty snapshot marks
        // this as a fresh session whose journal still needs replaying.
        let mut journal = self.journal.lock();
        let cursor = journal.sequence;
        for label in layouts.keys() {
            journal.pending.insert(
                label.clone(),
                Snapshot {
                    data: json!({}),
                    cursor,
                },
            );
        }
        *self.layouts.lock() = layouts;
    }
}

pub fn restore(app: &AppHandle, state: &Shared) {
    let labels: Vec<_> = state.windows.layouts.lock().keys().cloned().collect();
    for label in labels {
        let mut config = app.config().app.windows[0].clone();
        config.label = label.clone();
        config.visible = false;
        config.width = config.min_width.unwrap_or(420.0);
        config.height = (config.height * 0.75).max(config.min_height.unwrap_or(320.0));
        config.x = None;
        config.y = None;
        config.center = true;
        // The window-state plugin restores bounds/maximization before showing;
        // the fresh-window anchor must not overwrite a restored placement.
        match WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
            Ok(window) => {
                let _ = window.set_always_on_top(preferences_for(state, &label).always_on_top);
            }
            Err(error) => {
                log::error!("couldn't restore {label}; returning its tabs to main: {error}");
                for tab in state
                    .tabs
                    .write()
                    .iter_mut()
                    .filter(|tab| tab.window_label == label)
                {
                    tab.window_label = crate::settings::main_window();
                }
                state.windows.layouts.lock().remove(&label);
                state.windows.journal.lock().pending.remove(&label);
                crate::tabs_changed(app, state);
            }
        }
    }
}

pub fn begin_shutdown(app: &AppHandle, state: &Shared) {
    if !state.windows.quitting.swap(true, Ordering::Relaxed) {
        crate::persist(app, state);
    }
}

/// One ordered event stream lets a new webview replay everything since the
/// source's snapshot, including messages received while the native window loads.
pub fn install(app: &AppHandle, state: &Shared) {
    for name in EVENTS {
        let state = state.clone();
        let app_handle = app.clone();
        app.listen(*name, move |event| {
            let Ok(payload) = serde_json::from_str(event.payload()) else {
                return;
            };
            let mut journal = state.windows.journal.lock();
            journal.sequence += 1;
            let event = Event {
                sequence: journal.sequence,
                name: (*name).into(),
                payload,
            };
            journal.events.push_back(event.clone());
            // Pending transfers retain their entire gap. Otherwise only recent
            // events are needed to cover the source's IPC round trip.
            let oldest = journal
                .pending
                .values()
                .map(|s| s.cursor)
                .min()
                .unwrap_or(journal.sequence);
            while journal.events.len() > 4096
                && journal.events.front().is_some_and(|e| e.sequence <= oldest)
            {
                journal.events.pop_front();
            }
            let _ = app_handle.emit("window://event", event);
        });
    }
}

pub fn preferences_for(state: &Shared, label: &str) -> Preferences {
    let mut value =
        serde_json::to_value(&*state.preferences.read()).expect("preferences serialize");
    if label != "main" {
        if let Some(local) = state.windows.layouts.lock().get(label) {
            for key in LOCAL_PREFERENCES {
                if let Some(v) = local.get(*key) {
                    value[*key] = v.clone();
                }
            }
        }
    }
    serde_json::from_value(value).expect("validated preferences")
}

/// Merge only edited fields, so another window cannot overwrite newer settings
/// or replace the main window's persisted pane tree with its own tree.
pub fn patch_preferences(state: &Shared, label: &str, patch: Value) -> Result<Preferences, String> {
    let Some(patch) = patch.as_object() else {
        return Err("Expected preference fields".into());
    };
    let mut global = serde_json::to_value(&*state.preferences.read()).map_err(|e| e.to_string())?;
    let mut local =
        serde_json::to_value(preferences_for(state, label)).map_err(|e| e.to_string())?;
    for (key, value) in patch {
        if label != "main" && LOCAL_PREFERENCES.contains(&key.as_str()) {
            local[key] = value.clone();
        } else {
            global[key] = value.clone();
        }
    }
    let result = serde_json::from_value(global).map_err(|e| e.to_string())?;
    let _: Preferences = serde_json::from_value(local.clone()).map_err(|e| e.to_string())?;
    if label != "main" {
        state.windows.layouts.lock().insert(label.into(), local);
    }
    Ok(result)
}

pub fn emit_preferences(app: &AppHandle, state: &Shared) {
    let preferences: HashMap<_, _> = app
        .webview_windows()
        .keys()
        .map(|label| (label.clone(), preferences_for(state, label)))
        .collect();
    let _ = app.emit("chat://preferences", preferences);
}

pub fn reorder(tabs: &mut [crate::settings::Tab], label: &str, ids: &[String]) {
    let mut seen = HashSet::new();
    let mut ordered: Vec<_> = ids
        .iter()
        .filter_map(|id| {
            tabs.iter()
                .find(|tab| &tab.id == id && tab.window_label == label)
        })
        .filter(|tab| seen.insert(tab.id.clone()))
        .cloned()
        .collect();
    ordered.extend(
        tabs.iter()
            .filter(|tab| tab.window_label == label && !seen.contains(&tab.id))
            .cloned(),
    );
    let mut ordered = ordered.into_iter();
    for tab in tabs.iter_mut().filter(|tab| tab.window_label == label) {
        *tab = ordered.next().expect("one entry per owned tab");
    }
}

/// The creating menu button's lower-left corner in webview CSS pixels.
#[derive(Clone, Copy, Deserialize)]
pub struct WindowAnchor {
    x: f64,
    y: f64,
}

struct OpeningPlacement {
    size: tauri::LogicalSize<f64>,
    origin: tauri::PhysicalPosition<f64>,
    centered: bool,
    work_area: Option<tauri::PhysicalRect<i32, u32>>,
}

fn opening_size(master_height: f64, min_width: f64, min_height: f64) -> tauri::LogicalSize<f64> {
    tauri::LogicalSize::new(min_width, (master_height * 0.75).round().max(min_height))
}

fn screen_anchor(
    content_origin: tauri::PhysicalPosition<i32>,
    scale: f64,
    anchor: WindowAnchor,
) -> tauri::PhysicalPosition<f64> {
    tauri::PhysicalPosition::new(
        f64::from(content_origin.x) + anchor.x * scale,
        f64::from(content_origin.y) + anchor.y * scale,
    )
}

fn opening_position(
    origin: tauri::PhysicalPosition<f64>,
    size: tauri::PhysicalSize<u32>,
    centered: bool,
    work_area: Option<&tauri::PhysicalRect<i32, u32>>,
) -> tauri::PhysicalPosition<i32> {
    let mut x = origin.x;
    let mut y = origin.y;
    if centered {
        x -= f64::from(size.width) / 2.0;
        y -= f64::from(size.height) / 2.0;
    }
    if let Some(area) = work_area {
        let left = f64::from(area.position.x);
        let top = f64::from(area.position.y);
        x = x.clamp(
            left,
            left + f64::from(area.size.width.saturating_sub(size.width)),
        );
        y = y.clamp(
            top,
            top + f64::from(area.size.height.saturating_sub(size.height)),
        );
    }
    tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32)
}

impl OpeningPlacement {
    fn capture(
        app: &AppHandle,
        source: &WebviewWindow,
        anchor: Option<WindowAnchor>,
    ) -> Result<Self, String> {
        let main = app
            .get_webview_window("main")
            .ok_or("The main window is closed")?;
        let scale = main.scale_factor().map_err(|e| e.to_string())?;
        let main_size = main.inner_size().map_err(|e| e.to_string())?;
        let config = &app.config().app.windows[0];
        let size = opening_size(
            f64::from(main_size.height) / scale,
            config.min_width.unwrap_or(420.0),
            config.min_height.unwrap_or(320.0).max(320.0),
        );
        let origin = if let Some(anchor) = anchor {
            screen_anchor(
                source.inner_position().map_err(|e| e.to_string())?,
                source.scale_factor().map_err(|e| e.to_string())?,
                anchor,
            )
        } else {
            let position = main.outer_position().map_err(|e| e.to_string())?;
            let size = main.outer_size().map_err(|e| e.to_string())?;
            tauri::PhysicalPosition::new(
                f64::from(position.x) + f64::from(size.width) / 2.0,
                f64::from(position.y) + f64::from(size.height) / 2.0,
            )
        };
        let reference = if anchor.is_some() { source } else { &main };
        let monitor = app
            .monitor_from_point(origin.x, origin.y)
            .ok()
            .flatten()
            .or_else(|| reference.current_monitor().ok().flatten());
        Ok(Self {
            size,
            origin,
            centered: anchor.is_none(),
            work_area: monitor.map(|m| *m.work_area()),
        })
    }

    fn apply(&self, window: &WebviewWindow) -> tauri::Result<()> {
        // Select the destination monitor before applying a logical size. This
        // keeps 420 CSS pixels consistent across displays with different DPI.
        window.set_position(tauri::PhysicalPosition::new(
            self.origin.x.round() as i32,
            self.origin.y.round() as i32,
        ))?;
        window.set_size(self.size)?;
        // Include the platform frame when centering and keeping the window on-screen.
        window.set_position(opening_position(
            self.origin,
            window.outer_size()?,
            self.centered,
            self.work_area.as_ref(),
        ))
    }
}

#[tauri::command]
pub async fn new_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Shared>,
    tab_id: Option<String>,
    snapshot: Snapshot,
    anchor: Option<WindowAnchor>,
) -> Result<String, String> {
    if let Some(id) = &tab_id {
        if !state
            .tabs
            .read()
            .iter()
            .any(|t| &t.id == id && t.window_label == window.label())
        {
            return Err("This tab is no longer in this window".into());
        }
    }
    let placement = OpeningPlacement::capture(&app, &window, anchor)?;
    let id = state
        .windows
        .next
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| "No more window IDs are available")?;
    let label = format!("chat-{id}");
    {
        let mut journal = state.windows.journal.lock();
        if journal
            .events
            .front()
            .is_some_and(|event| event.sequence > snapshot.cursor + 1)
        {
            return Err("Chat changed while opening the window. Please try again.".into());
        }
        journal.pending.insert(label.clone(), snapshot);
    }
    let mut local =
        serde_json::to_value(preferences_for(&state, window.label())).map_err(|e| e.to_string())?;
    local["paneLayout"] = json!({"root": {"kind": "pane", "id": 0}, "tabPanes": {}});
    local["paneChatZoom"] = json!({});
    local["splitLayout"] = json!("none");
    state.windows.layouts.lock().insert(label.clone(), local);

    // Clone the merged platform config so secondary windows get the same macOS
    // frame/traffic lights, minimum size, and HTML tab-drag handling as main.
    let mut config = app.config().app.windows[0].clone();
    config.label = label.clone();
    config.width = placement.size.width;
    config.height = placement.size.height;
    config.center = false;
    state
        .windows
        .placements
        .lock()
        .insert(label.clone(), placement);
    config.visible = false;
    config.x = None;
    config.y = None;
    let result =
        WebviewWindowBuilder::from_config(&app, &config).and_then(|builder| builder.build());
    let created = match result {
        Ok(created) => created,
        Err(error) => {
            state.windows.journal.lock().pending.remove(&label);
            state.windows.layouts.lock().remove(&label);
            state.windows.placements.lock().remove(&label);
            return Err(error.to_string());
        }
    };
    // Build first: a platform creation failure must never strand the tab.
    if let Some(id) = &tab_id {
        let mut tabs = state.tabs.write();
        if let Some(tab) = tabs
            .iter_mut()
            .find(|t| &t.id == id && t.window_label == window.label())
        {
            tab.window_label = label.clone();
        }
    }
    crate::tabs_changed(&app, &state);
    let _ = created.set_always_on_top(preferences_for(&state, &label).always_on_top);
    Ok(label)
}

#[tauri::command]
pub fn window_bootstrap(window: WebviewWindow, state: State<'_, Shared>) -> Value {
    let mut journal = state.windows.journal.lock();
    let snapshot = journal.pending.remove(window.label());
    let events: Vec<_> = snapshot
        .as_ref()
        .map(|snapshot| {
            journal
                .events
                .iter()
                .filter(|event| event.sequence > snapshot.cursor)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let through = journal.sequence;
    let data = snapshot.map(|s| s.data);
    drop(journal);
    let placement = state.windows.placements.lock().remove(window.label());
    if let Some(placement) = placement {
        if let Err(error) = placement.apply(&window) {
            log::warn!("couldn't position the new window: {error}");
        }
    }
    state.windows.loaded.lock().insert(window.label().into());
    let _ = window.show();
    let _ = window.set_focus();
    json!({"data": data, "events": events, "through": through})
}

#[tauri::command]
pub fn focus_tab_window(app: AppHandle, state: State<'_, Shared>, id: String) {
    if let Some(tab) = state.tabs.read().iter().find(|t| t.id == id) {
        if let Some(window) = app.get_webview_window(&tab.window_label) {
            let _ = window.set_focus();
            let _ = app.emit(
                "window://activate-tab",
                json!({"windowLabel": tab.window_label, "id": id}),
            );
        }
    }
}

#[tauri::command]
pub fn move_tab_to_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Shared>,
    id: String,
    source: String,
) -> Result<crate::settings::Tab, String> {
    let moved = transfer_tab(&mut state.tabs.write(), &id, &source, window.label())?;
    crate::tabs_changed(&app, &state);
    Ok(moved)
}

fn transfer_tab(
    tabs: &mut [crate::settings::Tab],
    id: &str,
    source: &str,
    destination: &str,
) -> Result<crate::settings::Tab, String> {
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == id && tab.window_label == source)
        .ok_or("The dragged tab is no longer in its source window")?;
    tab.window_label = destination.into();
    Ok(tab.clone())
}

#[tauri::command]
pub fn close_chat_window(window: WebviewWindow, state: State<'_, Shared>) -> Result<(), String> {
    state.windows.closing.lock().insert(window.label().into());
    window.close().map_err(|e| e.to_string())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<Shared>() else {
        return;
    };
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
            api.prevent_close();
            begin_shutdown(app, &state);
            app.exit(0);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if state.windows.loaded.lock().contains(window.label())
                && !state.windows.closing.lock().contains(window.label())
            {
                api.prevent_close();
                let _ = app.emit("window://close-request", window.label());
            }
        }
        tauri::WindowEvent::Destroyed
            if window.label() != "main" && !state.windows.quitting.load(Ordering::Relaxed) =>
        {
            state
                .tabs
                .write()
                .retain(|tab| tab.window_label != window.label());
            state.windows.layouts.lock().remove(window.label());
            state.windows.journal.lock().pending.remove(window.label());
            state.windows.closing.lock().remove(window.label());
            state.windows.loaded.lock().remove(window.label());
            state.windows.placements.lock().remove(window.label());
            crate::tabs_changed(app, &state);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[test]
    fn secondary_preferences_preserve_main_layout_and_merge_shared_fields() {
        let state = Arc::new(AppState::new());
        let main = state.preferences.read().clone();
        let merged = patch_preferences(
            &state,
            "chat-0",
            json!({"theme":"light", "muted":true,
            "paneLayout":{"root":{"kind":"pane","id":7}, "tabPanes":{}}}),
        )
        .unwrap();
        *state.preferences.write() = merged;
        assert_eq!(
            preferences_for(&state, "main").pane_layout,
            main.pane_layout
        );
        assert!(!preferences_for(&state, "main").muted);
        assert!(preferences_for(&state, "chat-0").muted);
        assert_eq!(preferences_for(&state, "chat-0").theme, "light");
        assert_eq!(
            preferences_for(&state, "chat-0").pane_layout.unwrap()["root"]["id"],
            7
        );
    }

    #[test]
    fn reorder_deduplicates_ids_and_keeps_other_windows_in_place() {
        let mut tabs: Vec<crate::settings::Tab> = ["a", "remote", "b"]
            .iter()
            .map(|id| {
                serde_json::from_value(
                    json!({"id":id,"kind":"channel","channel":"room","account":""}),
                )
                .unwrap()
            })
            .collect();
        tabs[1].window_label = "chat-1".into();
        reorder(
            &mut tabs,
            "main",
            &["b".into(), "remote".into(), "b".into()],
        );
        assert_eq!(
            tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["b", "remote", "a"]
        );
        assert_eq!(tabs[1].window_label, "chat-1");
    }

    #[test]
    fn transferring_tabs_preserves_identity_and_rejects_stale_sources() {
        let mut tabs: Vec<crate::settings::Tab> = ["a", "b"]
            .iter()
            .map(|id| {
                serde_json::from_value(
                    json!({"id":id,"kind":"channel","channel":"room","account":"viewer"}),
                )
                .unwrap()
            })
            .collect();
        let moved = transfer_tab(&mut tabs, "a", "main", "chat-1").unwrap();
        assert_eq!(moved.id, "a");
        assert_eq!(moved.account, "viewer");
        assert_eq!(moved.channel, "room");
        assert_eq!(moved.window_label, "chat-1");
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[1].window_label, "main");
        assert!(transfer_tab(&mut tabs, "a", "main", "chat-2").is_err());
        assert!(transfer_tab(&mut tabs, "closed", "main", "chat-2").is_err());
        assert_eq!(
            transfer_tab(&mut tabs, "a", "chat-1", "main")
                .unwrap()
                .window_label,
            "main"
        );
    }

    #[test]
    fn opening_dimensions_follow_master_height_with_a_floor() {
        assert_eq!(
            opening_size(760.0, 420.0, 320.0),
            tauri::LogicalSize::new(420.0, 570.0)
        );
        assert_eq!(
            opening_size(320.0, 420.0, 320.0),
            tauri::LogicalSize::new(420.0, 320.0)
        );
        assert_eq!(
            opening_size(1200.0, 420.0, 320.0),
            tauri::LogicalSize::new(420.0, 900.0)
        );
    }

    #[test]
    fn menu_anchor_uses_source_screen_position_and_display_scale() {
        let origin = screen_anchor(
            tauri::PhysicalPosition::new(-1920, 100),
            1.5,
            WindowAnchor { x: 200.0, y: 80.0 },
        );
        assert_eq!(origin, tauri::PhysicalPosition::new(-1620.0, 220.0));
        assert_eq!(
            opening_position(origin, tauri::PhysicalSize::new(630, 855), false, None),
            tauri::PhysicalPosition::new(-1620, 220)
        );
    }

    #[test]
    fn hotkeys_center_the_outer_frame_and_edge_anchors_stay_in_the_work_area() {
        let size = tauri::PhysicalSize::new(420, 570);
        assert_eq!(
            opening_position(tauri::PhysicalPosition::new(750.0, 580.0), size, true, None),
            tauri::PhysicalPosition::new(540, 295)
        );
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(-1920, 30),
            size: tauri::PhysicalSize::new(1920, 1050),
        };
        assert_eq!(
            opening_position(
                tauri::PhysicalPosition::new(-20.0, 1060.0),
                size,
                false,
                Some(&area)
            ),
            tauri::PhysicalPosition::new(-420, 510)
        );
    }

    #[test]
    fn saved_tabs_keep_their_window_and_older_tabs_default_to_main() {
        let tab: crate::settings::Tab = serde_json::from_value(json!({
            "id":"one", "channel":"room", "kind":"channel", "account":"", "windowLabel":"chat-4"
        }))
        .unwrap();
        assert_eq!(tab.window_label, "chat-4");
        let legacy: crate::settings::Tab = serde_json::from_value(json!({
            "id":"legacy", "channel":"room", "kind":"channel", "account":""
        }))
        .unwrap();
        assert_eq!(legacy.window_label, "main");
    }

    #[test]
    fn session_roundtrip_keeps_empty_windows_local_settings_and_unique_ids() {
        let state = Arc::new(AppState::new());
        state.windows.next.store(12, Ordering::Relaxed);
        let merged = patch_preferences(
            &state,
            "chat-3",
            json!({
                "muted":true, "alwaysOnTop":true, "chatZoom":125,
                "paneLayout":{"root":{"kind":"pane","id":7},"tabPanes":{"one":7}}
            }),
        )
        .unwrap();
        *state.preferences.write() = merged;
        state
            .windows
            .layouts
            .lock()
            .insert("chat-8".into(), json!({"muted":false}));
        let saved: Session =
            serde_json::from_value(serde_json::to_value(state.windows.session()).unwrap()).unwrap();
        assert!(saved.layouts["chat-3"].get("theme").is_none());
        let restored = Arc::new(AppState::new());
        let mut tabs: Vec<crate::settings::Tab> = serde_json::from_value(json!([
            {"id":"one","kind":"channel","channel":"room","account":"","windowLabel":"chat-3"}
        ]))
        .unwrap();
        restored
            .windows
            .load_session(saved, &mut tabs, &Preferences::default());
        assert_eq!(tabs[0].window_label, "chat-3");
        assert_eq!(restored.windows.session().layouts.len(), 2);
        assert_eq!(restored.windows.next.load(Ordering::Relaxed), 12);
        let local = preferences_for(&restored, "chat-3");
        assert!(local.muted && local.always_on_top);
        assert_eq!(local.chat_zoom, 125.0);
        assert_eq!(local.pane_layout.unwrap()["tabPanes"]["one"], 7);
        assert!(!preferences_for(&restored, "main").muted);
        assert_eq!(restored.windows.journal.lock().pending.len(), 2);
    }

    #[test]
    fn migration_recovers_owned_tabs_and_invalid_windows_without_reusing_ids() {
        let state = Arc::new(AppState::new());
        let mut tabs: Vec<crate::settings::Tab> = serde_json::from_value(json!([
            {"id":"one","kind":"channel","channel":"room","account":"","windowLabel":"chat-9"},
            {"id":"two","kind":"channel","channel":"room","account":"","windowLabel":"invalid"}
        ]))
        .unwrap();
        let saved: Session = serde_json::from_value(json!({"layouts":{
            "invalid":{}, "chat-4":{"muted":"bad"}, "chat-5":{"theme":"light","muted":true}
        }}))
        .unwrap();
        state
            .windows
            .load_session(saved, &mut tabs, &Preferences::default());
        assert_eq!(tabs[0].window_label, "chat-9");
        assert_eq!(tabs[1].window_label, "main");
        assert!(!state.windows.session().layouts.contains_key("invalid"));
        assert_eq!(preferences_for(&state, "chat-9").split_layout, "none");
        assert!(!preferences_for(&state, "chat-4").muted);
        assert!(preferences_for(&state, "chat-5").muted);
        assert_eq!(
            preferences_for(&state, "chat-5").theme,
            Preferences::default().theme
        );
        assert_eq!(state.windows.next.load(Ordering::Relaxed), 10);
    }
}
