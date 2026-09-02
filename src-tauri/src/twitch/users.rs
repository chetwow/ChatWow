//! Looking someone up by name.
//!
//! Chat commands are typed with names (`/ban forsen`) and every Helix
//! moderation endpoint takes numeric ids, so each one that names a user costs
//! `lookup_id` first. `fetch_profile` is the other direction: the same
//! endpoint read for what it says *about* the user, which is what the card
//! behind a clicked username shows above the fold.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashMap;

use super::helix::Helix;

/// The numeric id behind a login, or a plain "no such user" if Twitch doesn't
/// know the name -- which is the usual reason a command fails, and reads far
/// better than the empty result set Twitch actually answers with.
pub async fn lookup_id(helix: &Helix<'_>, login: &str) -> Result<String> {
    let response = helix.get("users", &[("login", login)]).await?;
    response["data"]
        .get(0)
        .and_then(|user| user["id"].as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("There's no Twitch user named \"{login}\""))
}

/// Who someone is, as far as the two fields a user card leads with go.
///
/// Deliberately not the display name: the message that was clicked already
/// carries the one Twitch sent with it, so re-fetching it would only add a way
/// for the card to disagree with the row above it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Empty if Twitch has no avatar for them.
    pub avatar_url: String,
    /// Account creation, ISO 8601. Formatted in the frontend, where the
    /// "13 years ago" beside it is recomputed as the card is opened.
    pub created_at: String,
}

#[derive(Deserialize)]
struct UsersResponse {
    #[serde(default)]
    data: Vec<HelixUser>,
}

#[derive(Deserialize)]
struct HelixUser {
    /// Only read by `fetch_avatars`, which asks about many people at once and
    /// has to map each answer back to the name it asked about.
    #[serde(default)]
    login: String,
    #[serde(default)]
    profile_image_url: String,
    #[serde(default)]
    created_at: String,
}

fn profile_from(response: UsersResponse) -> Option<Profile> {
    let user = response.data.into_iter().next()?;
    Some(Profile {
        avatar_url: user.profile_image_url,
        created_at: user.created_at,
    })
}

/// Get Users needs a token but no scope, so any signed-in session can ask.
/// Signed out there is no token at all -- this app is a public client with no
/// secret, so it can't mint an app token either -- and the caller falls back to
/// an unauthenticated source (see `usercard`).
pub async fn fetch_profile(helix: &Helix<'_>, login: &str) -> Result<Profile> {
    let response = helix.get("users", &[("login", login)]).await?;
    let parsed: UsersResponse = serde_json::from_value(response)
        .map_err(|error| anyhow!("unexpected Twitch user response: {error}"))?;
    profile_from(parsed).ok_or_else(|| anyhow!("There's no Twitch user named \"{login}\""))
}

/// Helix takes up to 100 `login` parameters per call to Get Users.
const MAX_LOGINS: usize = 100;

/// Every login's profile picture, for the picture a tab draws behind its name.
///
/// One call for every open channel rather than one per channel: the same
/// endpoint `fetch_profile` reads for one person answers about a hundred at a
/// time. A login Twitch doesn't know, or has no picture for, simply isn't in
/// the map -- the caller draws nothing, which is also what being signed out
/// gets you, since Get Users needs a token this app can only have from a
/// signed-in account.
pub async fn fetch_avatars(
    helix: &Helix<'_>,
    logins: &[String],
) -> Result<HashMap<String, String>> {
    let mut avatars = HashMap::new();
    for chunk in logins.chunks(MAX_LOGINS) {
        let query: Vec<(&str, &str)> =
            chunk.iter().map(|login| ("login", login.as_str())).collect();
        let response = helix.get("users", &query).await?;
        let parsed: UsersResponse = serde_json::from_value(response)
            .map_err(|error| anyhow!("unexpected Twitch user response: {error}"))?;
        for user in parsed.data {
            if user.login.is_empty() || user.profile_image_url.is_empty() {
                continue;
            }
            avatars.insert(user.login.to_lowercase(), user.profile_image_url);
        }
    }
    Ok(avatars)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Option<Profile> {
        profile_from(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn reads_the_avatar_and_the_creation_date() {
        let profile = parse(
            r#"{"data":[{"id":"22484632","login":"forsen","display_name":"forsen",
                "broadcaster_type":"partner","description":"",
                "profile_image_url":"https://static-cdn.jtvnw.net/f-600x600.png",
                "created_at":"2011-05-19T00:28:28Z"}]}"#,
        )
        .expect("a user");
        assert_eq!(profile.avatar_url, "https://static-cdn.jtvnw.net/f-600x600.png");
        assert_eq!(profile.created_at, "2011-05-19T00:28:28Z");
    }

    #[test]
    fn a_name_twitch_doesnt_know_is_an_empty_set_rather_than_an_error() {
        // Which is why the caller turns it into a sentence of its own.
        assert!(parse(r#"{"data":[]}"#).is_none());
    }

    #[test]
    fn a_user_with_no_avatar_is_still_a_profile() {
        let profile = parse(r#"{"data":[{"created_at":"2020-01-01T00:00:00Z"}]}"#).expect("a user");
        assert!(profile.avatar_url.is_empty());
        assert_eq!(profile.created_at, "2020-01-01T00:00:00Z");
    }
}
