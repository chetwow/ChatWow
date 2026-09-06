//! Deterministic token-service failures; no Twitch requests or real credentials.
use super::*;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn a_wake_notification_interrupts_the_hourly_wait() {
    let state = Arc::new(AppState::new());
    let start = tokio::time::Instant::now();
    let waiting = Arc::clone(&state);
    let task = tokio::spawn(async move { wait_for_token_check(&waiting, false).await });
    tokio::time::sleep(Duration::from_secs(15)).await;
    state.token_check.notify_one();
    task.await.unwrap();
    assert_eq!(start.elapsed(), Duration::from_secs(15));
}

#[tokio::test(start_paused = true)]
async fn a_pending_rejection_and_an_unavailable_network_both_retry_after_five_seconds() {
    let state = AppState::new();
    for retry in [false, true] {
        if !retry {
            state.token_check.notify_one();
        }
        let start = tokio::time::Instant::now();
        wait_for_token_check(&state, retry).await;
        assert_eq!(start.elapsed(), Duration::from_secs(5));
    }
}

struct FakeTokens {
    validations: Mutex<VecDeque<anyhow::Result<auth::Validation>>>,
    refreshes: Mutex<VecDeque<auth::RefreshOutcome>>,
    checked: Mutex<Vec<String>>,
    replace_during_refresh: Option<Shared>,
}

impl FakeTokens {
    fn new(
        validations: Vec<anyhow::Result<auth::Validation>>,
        refreshes: Vec<auth::RefreshOutcome>,
    ) -> Self {
        Self {
            validations: Mutex::new(validations.into()),
            refreshes: Mutex::new(refreshes.into()),
            checked: Mutex::new(Vec::new()),
            replace_during_refresh: None,
        }
    }
}

impl TokenAccess for FakeTokens {
    async fn validate(&self, token: &str) -> anyhow::Result<auth::Validation> {
        self.checked.lock().push(token.to_string());
        self.validations
            .lock()
            .pop_front()
            .expect("unexpected validation")
    }

    async fn refresh(&self, _: &str, _: &str) -> auth::RefreshOutcome {
        if let Some(state) = &self.replace_during_refresh {
            state.auth.write().accounts[0].access_token = "new-sign-in".into();
        }
        self.refreshes
            .lock()
            .pop_front()
            .expect("unexpected refresh")
    }

    async fn avatar(&self, _: &str, _: &str) -> Option<String> {
        None
    }
}

fn fixture() -> (Shared, settings::Account) {
    let state = Arc::new(AppState::new());
    let account = settings::Account {
        id: "123".into(),
        login: "tester".into(),
        access_token: "expired".into(),
        refresh_token: "refresh-old".into(),
        scopes: vec!["chat:read".into()],
        avatar_url: String::new(),
    };
    state.auth.write().accounts.push(account.clone());
    (state, account)
}

fn valid() -> anyhow::Result<auth::Validation> {
    Ok(auth::Validation {
        login: "tester".into(),
        user_id: "123".into(),
        scopes: vec!["chat:read".into()],
        expires_in: REFRESH_MARGIN_SECS + 3600,
    })
}

fn expired() -> anyhow::Result<auth::Validation> {
    let response = reqwest::Response::from(
        tauri::http::Response::builder()
            .status(401)
            .body("")
            .unwrap(),
    );
    Err(response.error_for_status().unwrap_err().into())
}

fn renewed() -> auth::RefreshOutcome {
    auth::RefreshOutcome::Renewed(auth::Tokens {
        access_token: "fresh".into(),
        refresh_token: "refresh-new".into(),
    })
}

#[tokio::test]
async fn an_expired_wake_token_is_refreshed_before_reconnect_is_allowed() {
    let (state, account) = fixture();
    let api = FakeTokens::new(vec![expired(), valid()], vec![renewed()]);
    let mut pass = TokenPass::default();
    pass.record(check_token_with(&state, &account, &api).await);
    assert!(pass.restart(false, true));
    assert!(pass.changed && pass.renewed && !pass.retry);
    assert_eq!(state.auth.read().accounts[0].access_token, "fresh");
    assert_eq!(*api.checked.lock(), ["expired", "fresh"]);
}

#[tokio::test]
async fn wake_network_failure_preserves_account_and_retries_until_recovered() {
    let (state, account) = fixture();
    let api = FakeTokens::new(
        vec![
            Err(anyhow::anyhow!("network unavailable")),
            expired(),
            valid(),
        ],
        vec![renewed()],
    );
    let mut failed = TokenPass::default();
    failed.record(check_token_with(&state, &account, &api).await);
    assert!(failed.retry && !failed.changed);
    assert!(!failed.restart(false, true));
    assert_eq!(state.auth.read().accounts[0].refresh_token, "refresh-old");
    let mut recovered = TokenPass::default();
    recovered.record(check_token_with(&state, &account, &api).await);
    assert!(recovered.restart(false, true));
    assert!(!recovered.retry);
}

#[tokio::test]
async fn an_unreachable_refresh_does_not_sign_out_the_account() {
    let (state, account) = fixture();
    let api = FakeTokens::new(
        vec![expired()],
        vec![auth::RefreshOutcome::Unreachable("offline".into())],
    );
    assert!(matches!(
        check_token_with(&state, &account, &api).await,
        TokenCheck::Retry
    ));
    assert_eq!(state.auth.read().accounts[0].access_token, "expired");
}

#[tokio::test]
async fn rotated_refresh_tokens_survive_a_failed_followup_request() {
    let (state, account) = fixture();
    let api = FakeTokens::new(
        vec![expired(), Err(anyhow::anyhow!("offline")), valid()],
        vec![renewed()],
    );
    let mut pass = TokenPass::default();
    pass.record(check_token_with(&state, &account, &api).await);
    assert!(pass.changed && pass.retry);
    assert!(!pass.restart(false, true));
    let saved = state.auth.read().accounts[0].clone();
    assert_eq!(saved.refresh_token, "refresh-new");
    assert!(matches!(
        check_token_with(&state, &saved, &api).await,
        TokenCheck::Unchanged
    ));
    assert_eq!(*api.checked.lock(), ["expired", "fresh", "fresh"]);
}

#[tokio::test]
async fn routine_validation_and_renewal_leave_healthy_sockets_alone() {
    let (state, account) = fixture();
    for api in [
        FakeTokens::new(vec![valid()], vec![]),
        FakeTokens::new(vec![expired(), valid()], vec![renewed()]),
    ] {
        let mut pass = TokenPass::default();
        pass.record(check_token_with(&state, &account, &api).await);
        assert!(!pass.restart(false, false));
    }
}

#[tokio::test]
async fn a_refresh_refusal_removes_only_the_grant_we_checked() {
    for replacement in [false, true] {
        let (state, account) = fixture();
        let mut api = FakeTokens::new(
            vec![expired()],
            vec![auth::RefreshOutcome::Rejected("revoked".into())],
        );
        if replacement {
            api.replace_during_refresh = Some(Arc::clone(&state));
        }
        let result = check_token_with(&state, &account, &api).await;
        if replacement {
            assert!(matches!(result, TokenCheck::Unchanged));
            assert_eq!(state.auth.read().accounts[0].access_token, "new-sign-in");
        } else {
            assert!(matches!(result, TokenCheck::Lost));
            assert!(state.auth.read().accounts.is_empty());
        }
    }
}

#[tokio::test]
async fn an_old_refresh_cannot_overwrite_a_new_sign_in() {
    let (state, account) = fixture();
    let mut api = FakeTokens::new(vec![expired(), valid()], vec![renewed()]);
    api.replace_during_refresh = Some(Arc::clone(&state));
    assert!(matches!(
        check_token_with(&state, &account, &api).await,
        TokenCheck::Unchanged
    ));
    assert_eq!(state.auth.read().accounts[0].access_token, "new-sign-in");
}
