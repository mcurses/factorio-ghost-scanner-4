import type {
    BoundingBox,
    ItemStackDefinition,
    LogisticFilterWrite,
    LuaConstantCombinatorControlBehavior,
    LuaEntity,
    LuaEntityPrototype,
    LuaForce,
    LuaSurface,
    LuaTilePrototype,
    MapPosition,
    QualityID,
    SurfaceIndex,
    UnitNumber
} from "factorio:runtime";

import {
    AreasPerTickSetting,
    FullRescanIntervalSetting,
    IgnoreAssignedGhostsSetting,
    MaxResultsSetting,
    NegativeOutputSetting,
    RoundToStackSetting,
    ShowHiddenSetting,
    UpdateIntervalSetting
} from "./setting_names";

// How it works (4.3.0):
//
// Area scans (find_entities_filtered over a roboport's construction area) cost about the
// same no matter how few ghosts they return, because the engine still walks every entity
// in the area. Scanning every cell of every network continuously was the dominant cost of
// the mod. Instead, ghost-like entities are now *tracked*:
//
// - Build/mark/death events hand us new ghosts, tile ghosts, item request proxies,
//   upgrade-marked entities and cliffs marked for deconstruction; they go into
//   storage.tracked without any area scan.
// - Every update interval the tracked entities are re-checked (still valid, still marked,
//   assigned or not) and summed per logistic network. Entities outside every network that
//   has a scanner are dropped.
// - Area scans still exist, but only as a slow self-healing pass spread evenly over the
//   full rescan interval (catches anything no event told us about), plus immediate scans
//   of the area of a newly built scanner or roboport.

interface GhostScanner {
    id: UnitNumber;
    entity: LuaEntity;
}

const enum Kind {
    Ghost = 1,
    Tile = 2,
    Proxy = 3,
    Upgrade = 4,
    Cliff = 5
}

interface Tracked {
    entity: LuaEntity;
    kind: Kind;
    position: MapPosition;
    // An entity ghost with item requests turns into an item request proxy once a robot
    // builds it; no event announces that proxy, so we look for it when the ghost vanishes.
    hadRequests?: boolean;
}

// One area scan: a cell's construction area, or a whole space platform (no area).
interface ScanJob {
    surface: LuaSurface;
    area?: BoundingBox;
}

interface Storage {
    lookupItemsToPlaceThis: LuaMap<string, ItemStackDefinition[]>;
    ghostScanners: GhostScanner[];
    tracked: LuaMap<SurfaceIndex, LuaMap<string, Tracked>>;
    priorityJobs: ScanJob[];
    healJobs: ScanJob[];
    healIndex: number;
    healCredit: number;
    healPassStart: number;
    healFast: boolean;
    outputEmpty: LuaMap<UnitNumber, boolean>;
    initMod: boolean;
}

declare const storage: Storage;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ModLog = (_message: string) => {
    // uncomment to debug
    // game.print(message);
    // log(message);
};

const ScannerName = "ghost-scanner-ia";
const ScanTypes = ["entity-ghost", "tile-ghost", "item-request-proxy", "cliff"];

let scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
let updateInterval = settings.global[UpdateIntervalSetting].value as number;
let fullRescanInterval = settings.global[FullRescanIntervalSetting].value as number;
let maxResults: number | undefined = settings.global[MaxResultsSetting].value as number;

if (maxResults === 0) {
    maxResults = undefined;
}

let showHidden = settings.global[ShowHiddenSetting].value as boolean;
let invertSign = settings.global[NegativeOutputSetting].value as boolean;
let roundToStack = settings.global[RoundToStackSetting].value as boolean;
// When enabled, ghosts/upgrades that already have a construction robot dispatched
// (LuaEntity.is_registered_for_construction()/is_registered_for_upgrade() == false)
// are not counted, preventing double-requesting while bots are already on their way.
let ignoreAssignedGhosts = settings.global[IgnoreAssignedGhostsSetting].value as boolean;

// ---------------------------------------------------------------------------------------
// Tracking

const TrackedOn = (surface: LuaSurface) => {
    let entries = storage.tracked.get(surface.index);
    if (!entries) {
        entries = new LuaMap<string, Tracked>();
        storage.tracked.set(surface.index, entries);
    }

    return entries;
};

const Track = (entity: LuaEntity) => {
    if (!entity.valid) {
        return;
    }

    let kind: Kind;
    let key: string;
    switch (entity.type) {
        case "entity-ghost":
            kind = Kind.Ghost;
            key = `u${entity.unit_number}`;
            break;
        case "tile-ghost":
            kind = Kind.Tile;
            key = `u${entity.unit_number}`;
            break;
        case "item-request-proxy":
            kind = Kind.Proxy;
            // Proxies have no unit_number; the registration number is stable per object.
            key = `r${script.register_on_object_destroyed(entity)[0]}`;
            break;
        case "cliff":
            if (!entity.to_be_deconstructed()) {
                return;
            }
            kind = Kind.Cliff;
            key = `r${script.register_on_object_destroyed(entity)[0]}`;
            break;
        default:
            if (!entity.to_be_upgraded() || entity.unit_number === undefined) {
                return;
            }
            kind = Kind.Upgrade;
            key = `g${entity.unit_number}`;
            break;
    }

    const entries = TrackedOn(entity.surface);
    if (!entries.has(key)) {
        entries.set(key, { entity, kind, position: entity.position });
    }
};

const RunScanJob = (job: ScanJob) => {
    if (!job.surface.valid) {
        return;
    }

    for (const e of job.surface.find_entities_filtered({ area: job.area, type: ScanTypes })) {
        Track(e);
    }

    for (const e of job.surface.find_entities_filtered({ area: job.area, to_be_upgraded: true })) {
        Track(e);
    }
};

const CellArea = (position: MapPosition, radius: number): BoundingBox => ({
    left_top: { x: position.x - radius, y: position.y - radius },
    right_bottom: { x: position.x + radius, y: position.y + radius }
});

// Scan jobs covering everything the given scanner can see.
const JobsForScanner = (scanner: LuaEntity, jobs: ScanJob[], seenNetworks: LuaSet<number>) => {
    const surface = scanner.surface;
    if (surface.platform) {
        if (!seenNetworks.has(-surface.index)) {
            seenNetworks.add(-surface.index);
            jobs.push({ surface });
        }

        return;
    }

    const network = surface.find_logistic_network_by_position(scanner.position, scanner.force);
    if (!network || seenNetworks.has(network.network_id)) {
        return;
    }

    seenNetworks.add(network.network_id);
    for (const cell of network.cells) {
        if (cell.valid && cell.construction_radius > 0) {
            jobs.push({ surface, area: CellArea(cell.owner.position, cell.construction_radius) });
        }
    }
};

const StartHealPass = () => {
    const jobs: ScanJob[] = [];
    const seenNetworks = new LuaSet<number>();
    for (const scanner of storage.ghostScanners) {
        if (scanner.entity.valid) {
            JobsForScanner(scanner.entity, jobs, seenNetworks);
        }
    }

    storage.healJobs = jobs;
    storage.healIndex = 0;
    storage.healCredit = 0;
    storage.healPassStart = game.tick;
    ModLog(`Self-heal pass: ${jobs.length} areas`);
};

const OnTick = () => {
    let budget = scanAreasPerTick;

    while (budget > 0 && storage.priorityJobs.length > 0) {
        RunScanJob(storage.priorityJobs.pop()!);
        --budget;
    }

    if (storage.healIndex >= storage.healJobs.length) {
        if (storage.healFast || game.tick - storage.healPassStart >= fullRescanInterval) {
            StartHealPass();
            if (storage.healJobs.length === 0) {
                storage.healFast = false;
            }
        }

        return;
    }

    // Spread a pass evenly over the rescan interval; the first pass after loading the mod
    // runs at full speed so outputs are complete within seconds.
    storage.healCredit += storage.healFast
        ? scanAreasPerTick
        : storage.healJobs.length / fullRescanInterval;

    while (budget > 0 && storage.healCredit >= 1 && storage.healIndex < storage.healJobs.length) {
        RunScanJob(storage.healJobs[storage.healIndex]);
        ++storage.healIndex;
        storage.healCredit -= 1;
        --budget;
    }

    if (storage.healIndex >= storage.healJobs.length) {
        storage.healFast = false;
    }
};

// ---------------------------------------------------------------------------------------
// Signal output

interface Group {
    scanners: GhostScanner[];
    signals: LogisticFilterWrite[];
    indexes: LuaMap<string, number>;
    counted: number;
}

const NewGroup = (): Group => ({
    scanners: [],
    signals: [],
    indexes: new LuaMap<string, number>(),
    counted: 0
});

const GetItemsToPlace = (prototype: LuaEntityPrototype | LuaTilePrototype) => {
    const cached = storage.lookupItemsToPlaceThis.get(prototype.name);
    if (cached) {
        return cached;
    }

    if (showHidden) {
        storage.lookupItemsToPlaceThis.set(prototype.name, prototype.items_to_place_this || []);
    } else {
        const itemsToPlaceFiltered: ItemStackDefinition[] = [];
        if (prototype.items_to_place_this) {
            for (const v of prototype.items_to_place_this) {
                const item = v.name && prototypes.item[v.name];
                if (item && !item.hidden) {
                    itemsToPlaceFiltered.push(v);
                }
            }
        }

        storage.lookupItemsToPlaceThis.set(prototype.name, itemsToPlaceFiltered);
    }

    return storage.lookupItemsToPlaceThis.get(prototype.name)!;
};

const AddSignal = (group: Group, name: string, count: number, quality?: QualityID) => {
    // Callers pass quality as a name string, a LuaQualityPrototype or nothing; normalize
    // so every ghost of the same item and quality accumulates into one slot. A constant
    // combinator section only outputs its first 1000 slots, so one slot per ghost silently
    // drops everything scanned last (tile ghosts) once a network has ~1000 entity ghosts.
    const qualityName =
        quality === undefined ? "normal" : typeof quality === "string" ? quality : quality.name;
    const itemUid = `${name}/${qualityName}`;

    const signalIndex = group.indexes.get(itemUid);
    let s: LogisticFilterWrite;
    if (signalIndex !== undefined) {
        s = group.signals[signalIndex];
    } else {
        group.indexes.set(itemUid, group.signals.length);
        s = {
            value: {
                comparator: "=",
                type: "item",
                name,
                quality: qualityName
            },
            min: 0
        };
        group.signals.push(s);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).min = s.min! + (invertSign ? -count : count);
};

// Adds what the tracked entity still needs to the group. Returns false once the entity
// no longer needs anything (built, cancelled, upgraded), so it can be dropped.
const AddEntitySignals = (entry: Tracked, group: Group, force: LuaForce) => {
    const e = entry.entity;
    if (maxResults && group.counted >= maxResults) {
        return;
    }

    switch (entry.kind) {
        case Kind.Ghost: {
            if (ignoreAssignedGhosts && !e.is_registered_for_construction()) {
                return;
            }
            for (const itemStack of GetItemsToPlace(e.ghost_prototype)) {
                AddSignal(group, itemStack.name, itemStack.count ?? 1, e.quality);
            }
            for (const requestItem of e.item_requests) {
                AddSignal(group, requestItem.name, requestItem.count, requestItem.quality);
            }
            break;
        }
        case Kind.Tile: {
            if (ignoreAssignedGhosts && !e.is_registered_for_construction()) {
                return;
            }
            for (const itemStack of GetItemsToPlace(e.ghost_prototype)) {
                // Use entity quality, not itemStack quality (itemStack.quality is typically undefined)
                AddSignal(group, itemStack.name, itemStack.count ?? 1, e.quality);
            }
            break;
        }
        case Kind.Proxy: {
            // Module/item-request proxies are also covered by is_registered_for_construction():
            // it returns false once a bot has been dispatched to deliver the requested items.
            if (ignoreAssignedGhosts && !e.is_registered_for_construction()) {
                return;
            }
            for (const requestItem of e.item_requests) {
                AddSignal(group, requestItem.name, requestItem.count, requestItem.quality);
            }
            break;
        }
        case Kind.Upgrade: {
            // is_registered_for_upgrade() is the upgrade analog of
            // is_registered_for_construction(): false once a bot has been dispatched.
            if (ignoreAssignedGhosts && !e.is_registered_for_upgrade()) {
                return;
            }
            const [upgradePrototype, upgradeQuality] = e.get_upgrade_target();
            if (!upgradePrototype) {
                return;
            }
            for (const itemStack of GetItemsToPlace(upgradePrototype)) {
                AddSignal(group, itemStack.name, itemStack.count ?? 1, upgradeQuality);
            }
            break;
        }
        case Kind.Cliff: {
            // Cliffs are not affected by the ignore-assigned setting: like the construction
            // variant, is_registered_for_deconstruction(force) returns false once a robot has
            // been dispatched, so cliffs whose explosives are on the way are always excluded.
            const explosive = e.prototype.cliff_explosive_prototype;
            if (!explosive || !e.is_registered_for_deconstruction(force)) {
                return;
            }
            AddSignal(group, explosive, 1, "normal"); // have to specify a quality here otherwise only a virtual signal gets set
            break;
        }
    }

    ++group.counted;
};

const StillNeeded = (entry: Tracked) => {
    const e = entry.entity;
    if (!e.valid) {
        return false;
    }

    switch (entry.kind) {
        case Kind.Upgrade:
            return e.to_be_upgraded();
        case Kind.Cliff:
            return e.to_be_deconstructed();
        case Kind.Ghost:
            entry.hadRequests = e.item_requests.length > 0;
            return true;
        default:
            return true;
    }
};

const ClearCombinator = (controlBehavior: LuaConstantCombinatorControlBehavior) => {
    if (controlBehavior.sections_count !== 1) {
        ModLog("Cleaning scanner");
        for (let i = 1; i <= controlBehavior.sections_count; ++i) {
            controlBehavior.remove_section(1);
        }

        controlBehavior.add_section()!.filters = [];
    } else {
        controlBehavior.get_section(1)!.filters = [];
    }
};

const WriteOutput = (scanner: GhostScanner, signals: LogisticFilterWrite[] | undefined) => {
    const empty = !signals || signals.length === 0;
    if (empty && storage.outputEmpty.get(scanner.id)) {
        return;
    }

    const controlBehavior =
        scanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
    if (!controlBehavior) {
        return;
    }

    ClearCombinator(controlBehavior);
    if (!empty) {
        controlBehavior.get_section(1)!.filters = signals;
    }

    storage.outputEmpty.set(scanner.id, empty);
};

// Groups scanners by what they can see: their logistic network, or their whole platform.
const BuildGroups = () => {
    const byNetwork = new LuaMap<number, Group>();
    const byPlatform = new LuaMap<string, Group>();
    const forcesBySurface = new LuaMap<SurfaceIndex, LuaMap<string, LuaForce>>();
    const noOutput: GhostScanner[] = [];

    for (let i = storage.ghostScanners.length - 1; i >= 0; --i) {
        const scanner = storage.ghostScanners[i];
        // A scanner can be destroyed without any of our events firing (for example when
        // its surface is deleted); never dereference a stale record.
        if (!scanner.entity || !scanner.entity.valid) {
            ModLog(`Dropping scanner ${scanner.id} with an invalid entity`);
            storage.ghostScanners.splice(i, 1);
            storage.outputEmpty.delete(scanner.id);
            continue;
        }

        const entity = scanner.entity;
        const controlBehavior =
            entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
        if (!controlBehavior || !controlBehavior.enabled) {
            noOutput.push(scanner);
            continue;
        }

        const surface = entity.surface;
        let group: Group;
        if (surface.platform) {
            const key = `${surface.index}/${entity.force_index}`;
            group = byPlatform.get(key) ?? NewGroup();
            byPlatform.set(key, group);
        } else {
            const network = surface.find_logistic_network_by_position(
                entity.position,
                entity.force
            );
            if (!network) {
                noOutput.push(scanner);
                continue;
            }
            group = byNetwork.get(network.network_id) ?? NewGroup();
            byNetwork.set(network.network_id, group);
        }

        group.scanners.push(scanner);
        let forces = forcesBySurface.get(surface.index);
        if (!forces) {
            forces = new LuaMap<string, LuaForce>();
            forcesBySurface.set(surface.index, forces);
        }
        forces.set(entity.force.name, entity.force as LuaForce);
    }

    return { byNetwork, byPlatform, forcesBySurface, noOutput };
};

const RoundToStacks = (group: Group) => {
    if (!roundToStack) {
        return;
    }

    const roundFunc = invertSign ? math.floor : math.ceil;
    for (const signal of group.signals) {
        const stackSize = prototypes.item[(signal.value as { name: string }).name].stack_size;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (signal as any).min = roundFunc(signal.min! / stackSize) * stackSize;
    }
};

const UpdateOutputs = () => {
    const { byNetwork, byPlatform, forcesBySurface, noOutput } = BuildGroups();

    for (const [surfaceIndex, entries] of storage.tracked) {
        const forces = forcesBySurface.get(surfaceIndex);
        const surface = game.surfaces[surfaceIndex];
        if (!forces || !surface || !surface.valid) {
            // Nothing scans this surface; area scans will find these again if that changes.
            storage.tracked.delete(surfaceIndex);
            continue;
        }

        const isPlatform = surface.platform !== undefined;
        for (const [key, entry] of entries) {
            if (!StillNeeded(entry)) {
                if (entry.hadRequests && entry.kind === Kind.Ghost) {
                    // The ghost was probably built and left an item request proxy behind.
                    const p = entry.position;
                    storage.priorityJobs.push({ surface, area: CellArea(p, 0.5) });
                }
                entries.delete(key);
                continue;
            }

            const e = entry.entity;
            let matched = false;
            // Cliffs are neutral; they count for every force that has a scanner here.
            for (const [, force] of forces) {
                if (entry.kind !== Kind.Cliff && e.force_index !== force.index) {
                    continue;
                }

                if (isPlatform) {
                    const group = byPlatform.get(`${surfaceIndex}/${force.index}`);
                    if (group) {
                        matched = true;
                        AddEntitySignals(entry, group, force);
                    }
                    continue;
                }

                for (const network of surface.find_logistic_networks_by_construction_area(
                    entry.position,
                    force
                )) {
                    const group = byNetwork.get(network.network_id);
                    if (group) {
                        matched = true;
                        AddEntitySignals(entry, group, force);
                    }
                }
            }

            if (!matched) {
                entries.delete(key);
            }
        }
    }

    for (const groups of [byNetwork, byPlatform]) {
        for (const [, group] of groups) {
            RoundToStacks(group);
            for (const scanner of group.scanners) {
                WriteOutput(scanner, group.signals);
            }
        }
    }

    for (const scanner of noOutput) {
        WriteOutput(scanner, undefined);
    }
};

// ---------------------------------------------------------------------------------------
// Events

const AddScanner = (entity: LuaEntity) => {
    entity.operable = false;
    if (!storage.ghostScanners.some(s => s.id === entity.unit_number)) {
        storage.ghostScanners.push({ id: entity.unit_number!, entity });
    }

    // Scan what the new scanner can see right away instead of waiting for the next pass.
    JobsForScanner(entity, storage.priorityJobs, new LuaSet<number>());
};

const OnBuilt = (entity: LuaEntity) => {
    if (!entity.valid) {
        return;
    }

    if (entity.name === ScannerName) {
        ModLog("Found new ghost scanner");
        AddScanner(entity);
    } else if (entity.type === "roboport") {
        // A new roboport extends its network over ghosts that may have been placed earlier.
        const radius = entity.prototype.construction_radius ?? 0;
        if (radius > 0) {
            storage.priorityJobs.push({
                surface: entity.surface,
                area: CellArea(entity.position, radius)
            });
        }
    } else {
        Track(entity);
    }
};

const BuiltFilters = [
    { filter: "name", name: ScannerName },
    { filter: "type", type: "roboport" },
    { filter: "type", type: "entity-ghost" },
    { filter: "type", type: "tile-ghost" },
    { filter: "type", type: "item-request-proxy" }
] as const;

let registeredInterval: number | undefined;
const RegisterUpdateOutputs = () => {
    if (registeredInterval !== undefined) {
        script.on_nth_tick(registeredInterval, undefined);
    }
    registeredInterval = math.max(1, updateInterval);
    script.on_nth_tick(registeredInterval, UpdateOutputs);
};

const InitEvents = () => {
    script.on_event(defines.events.on_built_entity, e => OnBuilt(e.entity), [...BuiltFilters]);
    script.on_event(defines.events.on_robot_built_entity, e => OnBuilt(e.entity), [
        { filter: "name", name: ScannerName },
        { filter: "type", type: "roboport" }
    ]);
    script.on_event(defines.events.script_raised_built, e => OnBuilt(e.entity), [...BuiltFilters]);
    script.on_event(defines.events.script_raised_revive, e => OnBuilt(e.entity), [...BuiltFilters]);
    script.on_event(defines.events.on_space_platform_built_entity, e => OnBuilt(e.entity), [
        ...BuiltFilters
    ]);
    script.on_event(defines.events.on_post_entity_died, e => {
        if (e.ghost) {
            Track(e.ghost);
        }
    });
    script.on_event(defines.events.on_marked_for_upgrade, e => Track(e.entity));
    script.on_event(defines.events.on_marked_for_deconstruction, e => Track(e.entity), [
        { filter: "type", type: "cliff" }
    ]);

    script.on_event(defines.events.on_tick, OnTick);
    RegisterUpdateOutputs();
};

script.on_event(defines.events.on_runtime_mod_setting_changed, event => {
    ModLog("Settings changed");

    switch (event.setting) {
        case UpdateIntervalSetting: {
            updateInterval = settings.global[UpdateIntervalSetting].value as number;
            RegisterUpdateOutputs();
            break;
        }
        case AreasPerTickSetting: {
            scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
            break;
        }
        case FullRescanIntervalSetting: {
            fullRescanInterval = settings.global[FullRescanIntervalSetting].value as number;
            break;
        }
        case MaxResultsSetting: {
            maxResults = settings.global[MaxResultsSetting].value as number;

            if (maxResults === 0) {
                maxResults = undefined;
            }

            break;
        }
        case ShowHiddenSetting: {
            showHidden = settings.global[ShowHiddenSetting].value as boolean;
            storage.lookupItemsToPlaceThis = new LuaMap<string, ItemStackDefinition[]>();
            break;
        }
        case NegativeOutputSetting: {
            invertSign = settings.global[NegativeOutputSetting].value as boolean;
            break;
        }
        case RoundToStackSetting: {
            roundToStack = settings.global[RoundToStackSetting].value as boolean;
            break;
        }
        case IgnoreAssignedGhostsSetting: {
            ignoreAssignedGhosts = settings.global[IgnoreAssignedGhostsSetting].value as boolean;
            break;
        }
    }
});

// ---------------------------------------------------------------------------------------
// Diagnostics: remote.call("ghost-scanner-ia", "verify") recomputes every scanner's output
// with a brute-force area scan of all cells (the pre-4.3 algorithm) and reports mismatches.

const BruteForceSignals = (scanner: LuaEntity) => {
    const surface = scanner.surface;
    const force = scanner.force as LuaForce;
    const jobs: ScanJob[] = [];
    JobsForScanner(scanner, jobs, new LuaSet<number>());

    const seen = new LuaSet<string>();
    const group = NewGroup();
    for (const job of jobs) {
        const found = [
            ...surface.find_entities_filtered({ area: job.area, type: ScanTypes }),
            ...surface.find_entities_filtered({ area: job.area, to_be_upgraded: true })
        ];
        for (const e of found) {
            const key = `${e.unit_number ?? script.register_on_object_destroyed(e)[0]}/${e.type}`;
            if (seen.has(key)) {
                continue;
            }
            if (e.type !== "cliff" && e.force_index !== force.index) {
                continue;
            }
            // Same membership rule as the tracked path: the position must lie in the
            // construction area of the scanner's own network.
            if (!surface.platform) {
                const own = surface.find_logistic_network_by_position(scanner.position, force)!;
                const inOwn = surface
                    .find_logistic_networks_by_construction_area(e.position, force)
                    .some(n => n.network_id === own.network_id);
                if (!inOwn) {
                    continue;
                }
            }
            seen.add(key);
            let kind: Kind;
            switch (e.type) {
                case "entity-ghost":
                    kind = Kind.Ghost;
                    break;
                case "tile-ghost":
                    kind = Kind.Tile;
                    break;
                case "item-request-proxy":
                    kind = Kind.Proxy;
                    break;
                case "cliff":
                    if (!e.to_be_deconstructed()) {
                        continue;
                    }
                    kind = Kind.Cliff;
                    break;
                default:
                    kind = Kind.Upgrade;
            }
            AddEntitySignals({ entity: e, kind, position: e.position }, group, force);
        }
    }

    RoundToStacks(group);
    return group.signals;
};

const SignalsToMap = (signals: readonly LogisticFilterWrite[] | undefined) => {
    const m = new LuaMap<string, number>();
    for (const s of signals ?? []) {
        const v = s.value as { name: string; quality?: string };
        if (v && s.min !== undefined && s.min !== 0) {
            m.set(`${v.name}/${v.quality ?? "normal"}`, s.min);
        }
    }

    return m;
};

remote.add_interface("ghost-scanner-ia", {
    verify: () => {
        let checked = 0;
        const problems: string[] = [];
        for (const scanner of storage.ghostScanners) {
            if (!scanner.entity.valid) {
                continue;
            }
            const cb =
                scanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
            if (!cb.enabled) {
                continue;
            }
            ++checked;
            const actual = SignalsToMap(
                cb.sections_count > 0 ? (cb.get_section(1)!.filters as LogisticFilterWrite[]) : []
            );
            const expected = SignalsToMap(BruteForceSignals(scanner.entity));
            const diffs: string[] = [];
            for (const [k, v] of expected) {
                if (actual.get(k) !== v) {
                    diffs.push(`${k} want ${v} got ${actual.get(k) ?? 0}`);
                }
            }
            for (const [k, v] of actual) {
                if (!expected.has(k)) {
                    diffs.push(`${k} want 0 got ${v}`);
                }
            }
            if (diffs.length > 0) {
                const p = scanner.entity.position;
                problems.push(
                    `${scanner.entity.surface.name} (${p.x},${p.y}): ${diffs.join(", ")}`
                );
            }
        }

        return `checked ${checked} scanners, ${problems.length} mismatched\n${problems.join("\n")}`;
    },
    stats: () => {
        let tracked = 0;
        for (const [, entries] of storage.tracked) {
            for (const [,] of entries) {
                ++tracked;
            }
        }

        return `scanners ${storage.ghostScanners.length} tracked ${tracked} heal ${storage.healIndex}/${storage.healJobs.length} fast ${storage.healFast} priority ${storage.priorityJobs.length}`;
    }
});

// ---------------------------------------------------------------------------------------
// Lifecycle

const FindAllScanners = () => {
    for (const [, surface] of game.surfaces) {
        for (const entity of surface.find_entities_filtered({ name: ScannerName })) {
            entity.operable = false;
            if (!storage.ghostScanners.some(s => s.id === entity.unit_number)) {
                storage.ghostScanners.push({ id: entity.unit_number!, entity });
            }
        }
    }
};

const InitStorage = () => {
    ModLog("Initializing Storage");
    // Drop the per-scanner scan state of versions before 4.3.0.
    const old = storage as unknown as Record<string, unknown>;
    for (const field of [
        "scanSignals",
        "signalIndexes",
        "scanAreas",
        "foundEntities",
        "updateTimeout",
        "updateIndex"
    ]) {
        old[field] = undefined;
    }

    storage.initMod = true;
    storage.ghostScanners = (storage.ghostScanners || []).filter(s => s.entity && s.entity.valid);
    storage.tracked = storage.tracked || new LuaMap<SurfaceIndex, LuaMap<string, Tracked>>();
    storage.priorityJobs = [];
    storage.healJobs = [];
    storage.healIndex = 0;
    storage.healCredit = 0;
    storage.healPassStart = game.tick;
    // Run the first pass at full speed so scanners show complete results right away.
    storage.healFast = true;
    // Force every scanner to be rewritten once.
    storage.outputEmpty = new LuaMap<UnitNumber, boolean>();
    storage.lookupItemsToPlaceThis = new LuaMap<string, ItemStackDefinition[]>();
    FindAllScanners();
};

script.on_load(() => {
    InitEvents();
});

script.on_init(() => {
    ModLog("On Init");
    InitStorage();
    InitEvents();
});

script.on_configuration_changed(() => {
    ModLog("Config changed");
    InitStorage();
    InitEvents();
});
