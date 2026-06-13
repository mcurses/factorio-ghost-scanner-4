import { by_pixel, table } from "util";

import { Sprite4Way } from "factorio:prototype";

const layers = {
    layers: [
        {
            scale: 0.5,
            filename: "__GhostScanner4IgnoreAssigned__/graphics/entity/hr-ghost-scanner.png",
            width: 114,
            height: 102,
            frame_count: 1,
            shift: by_pixel(0, 5),
            // Teal tint so this "ignore assigned" variant is visually distinct on the map
            // from the upstream Ghost Scanner when both are running side-by-side.
            tint: { r: 0.45, g: 1, b: 0.85, a: 1 }
        },
        {
            scale: 0.5,
            filename: "__base__/graphics/entity/combinator/constant-combinator-shadow.png",
            width: 98,
            height: 66,
            frame_count: 1,
            shift: by_pixel(8.5, 5.5),
            draw_as_shadow: true
        }
    ]
};
declare function make_4way_animation_from_spritesheet(input: unknown): Sprite4Way;
const sprites = make_4way_animation_from_spritesheet(layers);

const scanner = table.deepcopy(data.raw["constant-combinator"]["constant-combinator"])!;
scanner.name = "ghost-scanner-ia";
scanner.icon = "__GhostScanner4IgnoreAssigned__/graphics/icons/ghost-scanner.png";
scanner.icon_size = 32;
scanner.minable!.result = "ghost-scanner-ia";
scanner.sprites = sprites;

data.extend([scanner]);
