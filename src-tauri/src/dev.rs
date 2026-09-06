//! Development webviews can reload while the backend keeps its sockets.
//! This entire module and its IPC command are absent from release builds.
use std::{collections::HashMap, sync::Arc};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager, State};

use crate::{state::AppState, twitch::badges::Badge, Shared};

#[derive(Default)]
pub struct DevStatus(RwLock<HashMap<String, String>>);

pub fn install(app: &AppHandle) {
    let statuses = Arc::new(DevStatus::default());
    app.manage(Arc::clone(&statuses));
    app.listen("chat://status", move |event| {
        #[derive(Deserialize)]
        struct Status {
            account: String,
            state: String,
        }
        if let Ok(status) = serde_json::from_str::<Status>(event.payload()) {
            let mut held = statuses.0.write();
            if status.state == "closed" {
                held.remove(&status.account);
            } else {
                held.insert(status.account, status.state);
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    ready: HashMap<String, bool>,
    roles: HashMap<String, &'static str>,
    emote_counts: HashMap<String, usize>,
    connections: HashMap<String, String>,
    global_emotes: usize,
    seventv_badges: HashMap<String, Badge>,
}

fn snapshot(state: &AppState, statuses: &DevStatus) -> Snapshot {
    let tabs = state.tabs.read().clone();
    let sessions = state.sessions.read();
    let mut ready = HashMap::new();
    let mut roles = HashMap::new();
    for tab in tabs.iter().filter(|tab| tab.is_channel()) {
        let session = sessions.get(&(tab.account.clone(), tab.channel.clone()));
        ready.insert(tab.id.clone(), session.is_some_and(|session| session.ready));
        let role = session.map(|session| &session.role);
        roles.insert(
            tab.id.clone(),
            if role.is_some_and(|role| role.broadcaster) {
                "broadcaster"
            } else if role.is_some_and(|role| role.moderator) {
                "moderator"
            } else {
                "viewer"
            },
        );
    }
    drop(sessions);
    Snapshot {
        ready,
        roles,
        emote_counts: state
            .data
            .read()
            .iter()
            .map(|(channel, room)| (channel.clone(), room.emotes.len()))
            .collect(),
        connections: statuses.0.read().clone(),
        global_emotes: state.global_emotes.read().len(),
        seventv_badges: state.seventv_badges.read().clone(),
    }
}

#[tauri::command]
pub fn dev_chat_snapshot(
    state: State<'_, Shared>,
    statuses: State<'_, Arc<DevStatus>>,
) -> Snapshot {
    snapshot(&state, &statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{settings::Tab, state::Session};

    #[test]
    fn snapshot_restores_account_specific_readiness_and_roles_without_reconnecting() {
        let state = AppState::new();
        let tabs: Vec<Tab> = serde_json::from_value(serde_json::json!([
            {"id":"a", "kind":"channel", "channel":"room", "account":"1"},
            {"id":"b", "kind":"channel", "channel":"room", "account":"2"},
            {"id":"listener", "kind":"mentions", "channel":"", "account":"1"}
        ]))
        .unwrap();
        *state.tabs.write() = tabs;
        let mut session = Session {
            ready: true,
            ..Default::default()
        };
        session.role.moderator = true;
        state
            .sessions
            .write()
            .insert(("1".into(), "room".into()), session);
        let statuses = DevStatus::default();
        statuses.0.write().insert("1".into(), "connected".into());
        let restored = snapshot(&state, &statuses);
        assert_eq!(restored.ready.get("a"), Some(&true));
        assert_eq!(restored.ready.get("b"), Some(&false));
        assert!(!restored.ready.contains_key("listener"));
        assert_eq!(restored.roles["a"], "moderator");
        assert_eq!(restored.roles["b"], "viewer");
        assert_eq!(restored.connections["1"], "connected");
        assert!(state.connections.read().is_empty());
    }
}
