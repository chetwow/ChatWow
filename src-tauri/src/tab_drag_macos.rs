//! Bridge native tab drags before WebKit translates their coordinates or animates them back.
use std::{collections::HashMap, sync::OnceLock};

use objc2::{
    runtime::{AnyObject, Bool, Imp, Method, Sel},
    sel, ClassType,
};
use objc2_app_kit::{NSDraggingSession, NSEvent, NSPasteboard, NSView};
use objc2_foundation::{NSPoint, NSSize, NSString};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition};

static APP: OnceLock<AppHandle> = OnceLock::new();
static BEGIN: OnceLock<Imp> = OnceLock::new();
static LEGACY_BEGIN: OnceLock<Imp> = OnceLock::new();
static ENDS: Mutex<Option<HashMap<usize, Imp>>> = Mutex::new(None);
static SESSIONS: Mutex<Option<HashMap<usize, String>>> = Mutex::new(None);
static RELEASES: Mutex<Option<HashMap<String, Option<PhysicalPosition<f64>>>>> = Mutex::new(None);

type Begin = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
) -> *mut NSDraggingSession;
type End = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, NSPoint, usize);
type LegacyBegin = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    NSPoint,
    NSSize,
    *mut AnyObject,
    *mut NSPasteboard,
    *mut AnyObject,
    Bool,
);

pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(method) =
        NSView::class().instance_method(sel!(beginDraggingSessionWithItems:event:source:))
    else {
        log::warn!("Native tab drag sessions are unavailable");
        return;
    };
    // AppKit invokes this selector on the main thread. Preserve its exact ABI and
    // always forward every drag to the original implementation.
    unsafe {
        BEGIN.set(method.implementation()).ok();
        method.set_implementation(std::mem::transmute::<Begin, Imp>(begin));
        // Released WebKit versions also use NSView's older dragImage entrypoint.
        if let Some(method) = NSView::class()
            .instance_method(sel!(dragImage:at:offset:event:pasteboard:source:slideBack:))
        {
            LEGACY_BEGIN.set(method.implementation()).ok();
            method.set_implementation(std::mem::transmute::<LegacyBegin, Imp>(legacy_begin));
        }
    }
}

pub fn take_release(label: &str) -> Option<Option<PhysicalPosition<f64>>> {
    RELEASES.lock().as_mut()?.remove(label)
}

fn is_tab_payload(bytes: &[u8]) -> bool {
    let marker = b"application/x-chatwow-tab";
    // WebKit's custom pasteboard archive stores ASCII MIME strings as 8-bit strings.
    bytes.windows(marker.len()).any(|part| part == marker)
}

unsafe extern "C-unwind" fn begin(
    view: *mut AnyObject,
    selector: Sel,
    items: *mut AnyObject,
    event: *mut AnyObject,
    source: *mut AnyObject,
) -> *mut NSDraggingSession {
    let original: Begin =
        std::mem::transmute(*BEGIN.get().expect("installed begin implementation"));
    let session = original(view, selector, items, event, source);
    let Some(session_ref) = session.as_ref() else {
        return session;
    };
    if !is_tab_board(&session_ref.draggingPasteboard()) {
        return session;
    }
    let Some(label) = window_label(view) else {
        return session;
    };
    watch_end(
        source,
        sel!(draggingSession:endedAtPoint:operation:),
        session as usize,
        label,
    );
    session_ref.setAnimatesToStartingPositionsOnCancelOrFail(false);
    log::debug!("native tab drag: return animation disabled");
    session
}

fn is_tab_board(pasteboard: &NSPasteboard) -> bool {
    // Only read the drag's custom archive, never the user's general clipboard.
    pasteboard
        .dataForType(&NSString::from_str(
            "com.apple.WebKit.custom-pasteboard-data",
        ))
        .is_some_and(|data| is_tab_payload(&data.to_vec()))
}

unsafe fn window_label(view: *mut AnyObject) -> Option<String> {
    let view = view.cast::<NSView>().as_ref()?;
    let window = view.window()?;
    let native = (&*window as *const _ as *mut std::ffi::c_void) as usize;
    APP.get()?
        .webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            (window.ns_window().ok().map(|p| p as usize) == Some(native)).then_some(label)
        })
}

unsafe fn watch_end(source: *mut AnyObject, selector: Sel, identity: usize, label: String) {
    let Some(source) = source.as_ref() else {
        return;
    };
    let Some(method) = source.class().instance_method(selector) else {
        return;
    };
    let key = method as *const Method as usize;
    ENDS.lock()
        .get_or_insert_with(HashMap::new)
        .entry(key)
        .or_insert_with(|| {
            let original = method.implementation();
            method.set_implementation(std::mem::transmute::<End, Imp>(ended));
            original
        });
    RELEASES
        .lock()
        .get_or_insert_with(HashMap::new)
        .remove(&label);
    SESSIONS
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert(identity, label);
}

unsafe extern "C-unwind" fn legacy_begin(
    view: *mut AnyObject,
    selector: Sel,
    image: *mut AnyObject,
    point: NSPoint,
    offset: NSSize,
    event: *mut AnyObject,
    pasteboard: *mut NSPasteboard,
    source: *mut AnyObject,
    slide_back: Bool,
) {
    let tab = pasteboard.as_ref().is_some_and(is_tab_board);
    let label = if tab { window_label(view) } else { None };
    let slide_back = if let Some(label) = label {
        watch_end(
            source,
            sel!(draggedImage:endedAt:operation:),
            image as usize,
            label,
        );
        log::debug!("native tab drag: legacy return animation disabled");
        Bool::NO
    } else {
        slide_back
    };
    let original: LegacyBegin = std::mem::transmute(
        *LEGACY_BEGIN
            .get()
            .expect("installed legacy drag implementation"),
    );
    original(
        view, selector, image, point, offset, event, pasteboard, source, slide_back,
    );
}

unsafe extern "C-unwind" fn ended(
    source: *mut AnyObject,
    selector: Sel,
    session: *mut AnyObject,
    point: NSPoint,
    operation: usize,
) {
    let label = SESSIONS
        .lock()
        .as_mut()
        .and_then(|sessions| sessions.remove(&(session as usize)));
    if let Some(label) = label {
        // Capture the native cursor synchronously, before WebKit emits dragend.
        // Tauri supplies the same physical desktop space as native window bounds.
        // A successful destination owns this drop. Escape ends with the mouse held.
        let released = if operation == 0 && NSEvent::pressedMouseButtons() == 0 {
            APP.get().and_then(|app| app.cursor_position().ok())
        } else {
            None
        };
        log::debug!(
            "native tab drag ended: source={label} operation={operation} release={released:?}"
        );
        RELEASES
            .lock()
            .get_or_insert_with(HashMap::new)
            .insert(label, released);
    }
    let method = (&*source)
        .class()
        .instance_method(selector)
        .expect("native drag end method");
    let original = ENDS
        .lock()
        .as_ref()
        .and_then(|ends| ends.get(&(method as *const Method as usize)))
        .copied();
    if let Some(original) = original {
        let original: End = std::mem::transmute(original);
        original(source, selector, session, point, operation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_tab_archives_are_recognized() {
        assert!(is_tab_payload(
            b"\0origin\0application/x-chatwow-tab\0payload"
        ));
        assert!(!is_tab_payload(b"text/plain\0a message"));
        assert!(!is_tab_payload(b"public.png"));
    }
}
