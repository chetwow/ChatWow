//! What the card behind a clicked username shows.
//!
//! Two halves, from two places, because Twitch only answers one of them.
//!
//! **Who they are** -- avatar, account age -- is Helix `GET /users`, which needs
//! a token but no scope. Signed out there isn't one (this app is a public
//! client with no secret, so there's no app token to fall back on either), so
//! the same two fields come from the unauthenticated source below instead.
//!
//! **How long they've followed, and how many months they've subscribed** are
//! not in Helix at all. `Get Users Follows` was removed in 2023 and both
//! replacements are scoped to *you*: `/channels/followed` requires the user id
//! in the token to match the one you're asking about, and
//! `/channels/followers?user_id=` requires `moderator:read:followers` and for
//! you to be the broadcaster or a moderator of that channel. Nothing public
//! answers "how long has X followed Y", and nothing at all answers cumulative
//! sub months for someone who isn't you.
//!
//! So that half comes from api.ivr.fi -- the same third party Chatterino's user
//! card uses, and effectively a proxy in front of Twitch's own private GraphQL
//! API. It's one person's public service with no SLA, which is why it lands in
//! its own `history` field: when it doesn't answer, the card says that row is
//! unavailable instead of losing the avatar and account age with it.
//!
//! (A PRIVMSG's `badge-info` tag does carry sub months for free -- but only for
//! someone currently subscribed who has already spoken in *this* channel, which
//! is far too narrow to build the row on.)

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::twitch::helix::Helix;
use crate::twitch::users::{self, Profile};

const IVR: &str = "https://api.ivr.fi/v2/twitch";

/// Everything the card renders, resolved. The display name and color aren't
/// here: the message that was clicked already carries both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCard {
    /// Empty when neither source had one; the card draws initials instead.
    pub avatar_url: String,
    /// Account creation, ISO 8601. Empty when neither source answered.
    pub created_at: String,
    /// `None` means the third-party half didn't answer -- which is not at all
    /// the same as "doesn't follow, never subscribed", so the card distinguishes
    /// them rather than showing a confident nothing.
    pub history: Option<History>,
}

/// What this chatter is to this channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// ISO 8601, empty when they don't follow the channel.
    pub followed_at: String,
    /// Cumulative months subscribed, counting past subscriptions. 0 if never.
    pub sub_months: u32,
    /// "1", "2" or "3". Empty unless they're subscribed right now.
    pub sub_tier: String,
    pub subscribed: bool,
    /// They've hidden their subscription, so the three fields above say
    /// nothing about it -- not even that it's absent.
    pub sub_hidden: bool,
}

/// Twitch logins are 1-25 of `[a-zA-Z0-9_]`, and both of these go into a URL
/// path. Anything else is rejected rather than escaped -- the same shape of
/// guard as the ids interpolated into the 7TV badge query.
fn is_login(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 25
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// IVR's error body. `message` is a sentence ("User was not found"), which is
/// what a failed lookup should say -- same idea as Helix's.
#[derive(Debug, Default, Deserialize)]
struct IvrError {
    #[serde(default)]
    error: IvrErrorBody,
}

#[derive(Debug, Default, Deserialize)]
struct IvrErrorBody {
    #[serde(default)]
    message: String,
}

fn ivr_error(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let parsed: IvrError = serde_json::from_str(body).unwrap_or_default();
    if parsed.error.message.is_empty() {
        anyhow!("ivr.fi answered {}", status.as_u16())
    } else {
        anyhow!("{}", parsed.error.message)
    }
}

/// One GET against IVR, with its own error sentence pulled out of the body.
async fn ivr_get(client: &reqwest::Client, path: &str, query: &[(&str, &str)]) -> Result<String> {
    let response = client
        .get(format!("{IVR}/{path}"))
        .query(query)
        .header("Accept", "application/json")
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(ivr_error(status, &body))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubageResponse {
    #[serde(default)]
    status_hidden: bool,
    #[serde(default)]
    followed_at: Option<String>,
    /// Every month they've ever subscribed, present even once the sub lapses.
    #[serde(default)]
    cumulative: Option<Cumulative>,
    /// The *current* subscription, and null when there isn't one -- which is
    /// the only thing separating "subscribed" from "was subscribed".
    #[serde(default)]
    meta: Option<Meta>,
}

#[derive(Deserialize)]
struct Cumulative {
    #[serde(default)]
    months: u32,
}

#[derive(Deserialize)]
struct Meta {
    #[serde(default)]
    tier: String,
}

fn history_from(response: SubageResponse) -> History {
    History {
        followed_at: response.followed_at.unwrap_or_default(),
        sub_months: response.cumulative.map(|c| c.months).unwrap_or_default(),
        sub_tier: response.meta.as_ref().map(|m| m.tier.clone()).unwrap_or_default(),
        subscribed: response.meta.is_some(),
        sub_hidden: response.status_hidden,
    }
}

/// The unauthenticated stand-in for Helix `GET /users`. Answers with an array,
/// and with the same two fields under different names.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IvrUser {
    #[serde(default)]
    logo: String,
    #[serde(default)]
    created_at: String,
}

fn profile_from(users: Vec<IvrUser>) -> Option<Profile> {
    let user = users.into_iter().next()?;
    Some(Profile {
        avatar_url: user.logo,
        created_at: user.created_at,
    })
}

async fn ivr_profile(client: &reqwest::Client, login: &str) -> Result<Profile> {
    let body = ivr_get(client, "user", &[("login", login)]).await?;
    let users: Vec<IvrUser> = serde_json::from_str(&body)
        .map_err(|error| anyhow!("unexpected ivr.fi user response: {error}"))?;
    profile_from(users).ok_or_else(|| anyhow!("There's no Twitch user named \"{login}\""))
}

/// Helix while there's a token, the unauthenticated source otherwise -- and
/// also when Helix refuses, since an expired token shouldn't cost the card its
/// avatar when something else will answer the same question.
async fn profile(
    client: &reqwest::Client,
    credentials: Option<&(String, String)>,
    login: &str,
) -> Result<Profile> {
    if let Some((client_id, token)) = credentials {
        let helix = Helix { client, client_id, token };
        match users::fetch_profile(&helix, login).await {
            Ok(profile) => return Ok(profile),
            Err(error) => eprintln!("user card: Helix profile failed ({error}); trying ivr.fi"),
        }
    }
    ivr_profile(client, login).await
}

async fn history(client: &reqwest::Client, login: &str, channel: &str) -> Option<History> {
    let path = format!("subage/{login}/{channel}");
    match ivr_get(client, &path, &[]).await {
        Ok(body) => match serde_json::from_str::<SubageResponse>(&body) {
            Ok(response) => Some(history_from(response)),
            Err(error) => {
                eprintln!("user card: unexpected ivr.fi subage response: {error}");
                None
            }
        },
        Err(error) => {
            eprintln!("user card: ivr.fi subage failed: {error}");
            None
        }
    }
}

/// Both halves at once. The card is opened by a click and read immediately, so
/// the two round trips overlap rather than queueing.
pub async fn fetch(
    client: &reqwest::Client,
    credentials: Option<(String, String)>,
    login: &str,
    channel: &str,
) -> Result<UserCard> {
    if !is_login(login) {
        return Err(anyhow!("\"{login}\" isn't a Twitch username"));
    }
    if !is_login(channel) {
        return Err(anyhow!("\"{channel}\" isn't a Twitch channel"));
    }

    let (profile, history) = tokio::join!(
        profile(client, credentials.as_ref(), login),
        history(client, login, channel),
    );

    let profile = match profile {
        Ok(profile) => profile,
        // Nothing answered at all, so there's no card to show -- say why.
        Err(error) if history.is_none() => return Err(error),
        // Half a card beats an error: the follow and sub rows still have
        // something to say about someone we couldn't otherwise describe.
        Err(_) => Profile::default(),
    };

    Ok(UserCard {
        avatar_url: profile.avatar_url,
        created_at: profile.created_at,
        history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subage(json: &str) -> History {
        history_from(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn a_current_subscriber_carries_their_tier_and_cumulative_months() {
        let history = subage(
            r#"{"statusHidden":false,"followedAt":"2015-07-03T10:28:10Z",
                "streak":{"months":24},"cumulative":{"months":148},
                "meta":{"type":"paid","tier":"3","endsAt":null}}"#,
        );
        assert!(history.subscribed);
        assert_eq!(history.sub_tier, "3");
        assert_eq!(history.sub_months, 148);
        assert_eq!(history.followed_at, "2015-07-03T10:28:10Z");
    }

    #[test]
    fn a_lapsed_subscriber_keeps_the_months_but_loses_the_tier() {
        // `cumulative` outlives the subscription; `meta` is what says it's
        // still running. Without both, "subscribed for 124 months" would be
        // claimed about someone who left years ago.
        let history = subage(
            r#"{"statusHidden":false,"followedAt":"2015-07-03T10:28:10Z",
                "streak":null,"cumulative":{"months":124},"meta":null}"#,
        );
        assert!(!history.subscribed);
        assert_eq!(history.sub_months, 124);
        assert!(history.sub_tier.is_empty());
    }

    #[test]
    fn someone_who_doesnt_follow_has_no_date_rather_than_a_wrong_one() {
        let history = subage(r#"{"statusHidden":false,"followedAt":null,"cumulative":null,"meta":null}"#);
        assert!(history.followed_at.is_empty());
        assert_eq!(history.sub_months, 0);
        assert!(!history.subscribed);
        assert!(!history.sub_hidden);
    }

    #[test]
    fn a_hidden_subscription_is_flagged_rather_than_reported_as_absent() {
        let history = subage(r#"{"statusHidden":true,"followedAt":null,"cumulative":null,"meta":null}"#);
        assert!(history.sub_hidden);
        assert!(!history.subscribed);
    }

    #[test]
    fn the_ivr_profile_fills_the_same_two_fields_helix_would() {
        let users: Vec<IvrUser> = serde_json::from_str(
            r#"[{"login":"forsen","displayName":"forsen","banned":false,
                 "logo":"https://static-cdn.jtvnw.net/f-600x600.png",
                 "createdAt":"2011-05-19T00:28:28.310449Z"}]"#,
        )
        .unwrap();
        let profile = profile_from(users).expect("a user");
        assert_eq!(profile.avatar_url, "https://static-cdn.jtvnw.net/f-600x600.png");
        assert_eq!(profile.created_at, "2011-05-19T00:28:28.310449Z");
    }

    #[test]
    fn ivr_errors_read_back_as_ivr_wrote_them() {
        let body = r#"{"statusCode":404,"error":{"message":"User was not found"}}"#;
        assert_eq!(
            ivr_error(reqwest::StatusCode::NOT_FOUND, body).to_string(),
            "User was not found"
        );
        assert_eq!(
            ivr_error(reqwest::StatusCode::BAD_GATEWAY, "<html>nope</html>").to_string(),
            "ivr.fi answered 502"
        );
    }

    #[test]
    fn only_real_logins_reach_the_url_path() {
        // They're pasted straight into the request path, so a slash or a dot
        // would be a different endpoint rather than a lookup.
        assert!(is_login("forsen"));
        assert!(is_login("some_user_99"));
        assert!(!is_login("../../v2/twitch/modvip"));
        assert!(!is_login("has space"));
        assert!(!is_login(""));
        assert!(!is_login(&"a".repeat(26)));
    }
}
