# factorio-ghost-scanner-4

Originally based on https://github.com/Tiavor/GhostScanner2.

Ported to typescript for (my) ease of development.

Please open an issue if you have a problem.

## Fork: "Ignore assigned ghosts"

This is a fork of [Cyberboss/factorio-ghost-scanner-4](https://github.com/Cyberboss/factorio-ghost-scanner-4)
that adds a single runtime-global mod setting:

- **`ghost-scanner-ignore-assigned-ghosts`** (bool, default `false`) — _"Ignore assigned ghosts"_

### Why

Stock Ghost Scanner counts **every** ghost in the logistic network, including "teal" ghosts that
already have a construction robot dispatched and en route with the item. In a circuit-controlled
supply system this causes double-requesting: the items are delivered, bots pick them up and fly off,
but the ghosts still exist, so the scanner keeps requesting the same items even though they are
already in flight (and no longer in the network's available contents).

### Behavior

When the setting is **off** (default) the mod behaves exactly like upstream Ghost Scanner 4.

When the setting is **on**, a ghost/entity is only counted while it is still waiting for a robot to
be dispatched. This uses the base-game API:

| Scanned type                  | Filter when setting is on          | Notes                                                                                                                                                         |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity ghosts                 | `is_registered_for_construction()` | primary case                                                                                                                                                  |
| Tile ghosts                   | `is_registered_for_construction()` |                                                                                                                                                               |
| Module / item-request proxies | `is_registered_for_construction()` | covers requests on already-built entities                                                                                                                     |
| Upgrades (`to_be_upgraded`)   | `is_registered_for_upgrade()`      | upgrade analog of the construction check                                                                                                                      |
| Cliffs (deconstruction)       | _(unchanged)_                      | already gated by `is_registered_for_deconstruction(force)`, which is also `false` once a bot is dispatched, so cliffs are filtered regardless of this setting |

All of these API methods return `false` once a construction/upgrade robot has been dispatched, so
the circuit output stops requesting items that are already on their way. The circuit output format,
quality handling, max-results limiting and stack rounding are all unchanged — the new logic is one
boolean API call per scanned ghost, gated behind the setting.

### Side-by-side comparison build (this branch)

The `side-by-side-compare` branch ships this as a **separate mod** so you can run it at the same
time as the upstream Ghost Scanner 4 and compare their outputs directly:

- Mod name: `GhostScanner4IgnoreAssigned`, title _"Ghost Scanner 4 (Ignore Assigned)"_
- A separate entity/item/recipe `ghost-scanner-ia` — _"Ghost Scanner (Ignore Assigned)"_ — with a
  teal tint so it is easy to tell apart from the original on the map.
- All mod settings are prefixed `ghost-scanner-ia-` (a separate setting block in Settings → Mod
  settings → Map), so the two mods do not clash over setting names.

Place one of each in the same logistic network, enable _"Ignore assigned ghosts"_ on the `-ia`
variant only, and compare the two combinators' outputs while construction bots are in flight.

The drop-in replacement build (same internal name as upstream, no rename) lives on the
`ignore-assigned-ghosts` branch. When you are happy with the results, switch to that branch (or just
remove this comparison mod) to go back to a single mod.

## Development

You'll need a node 22+ environment setup. VSCode is the recommended IDE.

Run `corepack enable` to ensure you're using the correct yarn version.

Run `yarn` to install dependencies like the typescript-to-lua compiler and typed-factorio definitions.

Run `yarn build` to build the mod `.zip` in the `build/` directory.

Run `yarn install_mod` to build and copy the mod to `~/AppData/Roaming/Factorio/mods`.

### Performance

This is a rough 1-to-1 port of GhostScanner2. In writing it, I've come to realize that there's a big opportunity for performance improvements if, instead of scanning for ghosts/related entities, the control script was reworked to be purely event driven when ghosts are created/built/deleted and scan only when logistic areas are created/updated/deleted.
