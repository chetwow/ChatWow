//! Twitch message-effect power-ups. IRC supplies an `animated-message`
//! msg-id and an animation-id; only known effects cross the render boundary.

use crate::irc::parse::IrcMessage;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct EffectEmote {
    pub name: String,
    /// Static artwork: motion belongs to the effect, so it can be paused.
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MessageEffect {
    CosmicAbyss,
    RainbowEclipse,
    EmoteParty { emotes: Vec<EffectEmote> },
}

pub fn resolve(msg: &IrcMessage) -> Option<MessageEffect> {
    if msg.command != "PRIVMSG" || msg.tag("msg-id") != Some("animated-message") {
        return None;
    }
    match msg.tag("animation-id")? {
        "cosmic-abyss" => Some(MessageEffect::CosmicAbyss),
        "rainbow-eclipse" => Some(MessageEffect::RainbowEclipse),
        // Twitch calls Emote Party "simmer" on the wire.
        "simmer" => Some(MessageEffect::EmoteParty {
            emotes: party_emotes(),
        }),
        _ => None,
    }
}

fn party_emotes() -> Vec<EffectEmote> {
    // These are decoration, never text-matched chat emotes or completion
    // inventory. Keep their static variants outside the animated ID disk cache.
    let mut emotes: Vec<_> = [("PogChamp", "305954156"), ("bleedPurple", "62835")]
        .into_iter()
        .map(|(name, id)| EffectEmote {
            name: name.to_string(),
            url: format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/static/dark/2.0"),
        })
        .collect();
    for bits in [5000, 10000] {
        emotes.push(EffectEmote {
            name: format!("Cheer{bits}"),
            url: format!(
                "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/static/{bits}/2.png"
            ),
        });
    }
    emotes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_effects_resolve_to_typed_metadata_and_party_art() {
        for (id, kind) in [
            ("cosmic-abyss", "cosmic-abyss"),
            ("rainbow-eclipse", "rainbow-eclipse"),
            ("simmer", "emote-party"),
        ] {
            let msg = crate::irc::parse::parse(&format!(
                "@msg-id=animated-message;animation-id={id} :alice!a@a PRIVMSG #room :hello"
            ))
            .unwrap();
            let value = serde_json::to_value(resolve(&msg).unwrap()).unwrap();
            assert_eq!(value["kind"], kind);
            if kind == "emote-party" {
                let emotes = value["emotes"].as_array().unwrap();
                assert_eq!(
                    emotes
                        .iter()
                        .map(|e| e["name"].as_str().unwrap())
                        .collect::<Vec<_>>(),
                    ["PogChamp", "bleedPurple", "Cheer5000", "Cheer10000"]
                );
                assert!(emotes
                    .iter()
                    .all(|e| e["url"].as_str().unwrap().contains("/static/")));
            }
        }
    }

    #[test]
    fn incomplete_unknown_and_non_message_effects_are_ordinary_messages() {
        for tags in [
            "animation-id=cosmic-abyss",
            "msg-id=animated-message",
            "msg-id=animated-message;animation-id=future-effect",
            "msg-id=gigantified-emote-message;animation-id=simmer",
        ] {
            let msg = crate::irc::parse::parse(&format!("@{tags} :alice!a@a PRIVMSG #room :hello"))
                .unwrap();
            assert!(resolve(&msg).is_none());
        }
        let msg = crate::irc::parse::parse(
            "@msg-id=animated-message;animation-id=simmer :tmi.twitch.tv USERNOTICE #room :hello",
        )
        .unwrap();
        assert!(resolve(&msg).is_none());
    }
}
