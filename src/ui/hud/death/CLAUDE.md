# HUD domain: the death screens

What a dead player sees, behind the `index.ts` barrel:

- `death_prompt_view.ts`: the pure, DOM-free core (registered in `UI_PURE_CORES`).
  `updateDeathPromptView(out, ...)` decides, per frame and into a caller-owned
  view (allocation-light), which surfaces show: the Release overlay for a fresh
  corpse (not in an arena match), its PvP Resurrect button (only while the corpse
  carries `Entity.pvpResurrect`, `src/sim/pvp/pvp_resurrect.ts`), and for a ghost
  the greyscale spirit mode, the standing hint line and the Resurrect at Corpse
  prompt within `CORPSE_REZ_RANGE` (both suppressed in a battleground match).
- The painting stays in `Hud.update` (`src/ui/hud.ts`): four write-elided
  `setDisplay` calls and the `spirit-mode` body class over the static
  `#death-overlay` / `#pvp-resurrect-btn` / `#ghost-hint` / `#ghost-prompt`
  markup in `index.html`. The buttons' clicks route to `IWorld.releaseSpirit`,
  `IWorld.pvpResurrect` and `IWorld.resurrectAtCorpse`; the server re-validates
  every one.

Pinned by `tests/pvp_resurrect.test.ts`.
