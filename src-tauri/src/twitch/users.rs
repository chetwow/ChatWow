//! Login to user id.
//!
//! Chat commands are typed with names (`/ban forsen`) and every Helix
//! moderation endpoint takes numeric ids, so each one that names a user costs
//! this lookup first.

use anyhow::{anyhow, Result};

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
