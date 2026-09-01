/// The Twitch app this ships against.
///
/// Committed on purpose. A Client ID is a *public* identifier -- it travels in
/// the clear on every OAuth request, so the binary is its intended home. The
/// confidential half is the client *secret*, which this app never uses: it's a
/// public client on the device code flow.
const DEFAULT_CLIENT_ID: &str = "d8ujk4io9tfkdju675zp4vow4rohng";

fn main() {
    // option_env! is resolved at compile time, so cargo has to know the build
    // depends on this variable or a changed Client ID won't trigger a rebuild.
    println!("cargo:rerun-if-env-changed=TWITCH_CLIENT_ID");

    // Set TWITCH_CLIENT_ID to build against a different Twitch app. Without it
    // every build gets the real one, so a plain `npm run tauri build` can't
    // silently ship a binary that asks its users for a Client ID.
    let client_id = std::env::var("TWITCH_CLIENT_ID")
        .ok()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    println!("cargo:rustc-env=TWITCH_CLIENT_ID={client_id}");

    tauri_build::build()
}
