# STM32 CubeMX Responsibility Matrix

## Goal
- Replace CubeMX-centric project bring-up flow with in-IDE STM32 workflows.
- Make first action obvious by splitting UI by context: Create / Code / Setup.

## Scope Matrix

| Category | CubeMX Responsibility | Current In-IDE State | Gap | Target Implementation |
| --- | --- | --- | --- | --- |
| Board/MCU Selection | Device and board picker | Board configurator exists in STM32 UX | Limited static profile mindset | Load all MCU definitions from `resources/stm32/mcu/*.json` dynamically |
| Clock Tree | RCC source and SYSCLK setup | Basic `clockSource` and `sysclkMHz` fields exist | No graph/tree validation | Add dedicated clock panel with constraint checks |
| Pin Assignment | Pin mux and conflict management | Pin visualizer/editor exists | No conflict solver and peripheral-level planner | Add conflict engine and peripheral intent mapping |
| Middleware Enablement | FreeRTOS/USB/ETH toggles and generated config | Basic middleware toggles exist | No middleware-specific config pages | Add per-middleware config forms and generated sections |
| Memory Configuration | Stack/heap/startup values | Stack/heap input exists | No linker-script awareness | Integrate linker view and section usage warnings |
| Code Generation | `.ioc`-driven source generation | Template + board config project generation exists | No full regenerate pipeline parity | Add regenerate engine with preserved user-code sections |
| Validation | Pin/clock/peripheral consistency checks | Minimal validation in UI | Missing full preflight diagnostics | Add one-click preflight report and blockers panel |
| Export/Build Flow | Toolchain and IDE project generation | VS Code task/launch generation exists | Needs one-screen operation hub | Consolidate build/flash/debug controls in workflow mode |
| Device Coverage | Broad MCU family coverage | MCU JSON count currently tied to local catalog | Coverage depends on bundled catalog size | Expand and regularly sync MCU catalog with staged validation |

## UX Mapping (Implemented Entry Points)
- Create Mode: `stm32ux.openBoardConfigurator`
- Code Mode: `stm32.openCommandCenter` + pin visualizer
- Setup Mode: `stm32ux.runEnvironmentCheck`
- Unified Entry: `stm32ux.openWorkflowStudio`

## Next Expansion Steps
1. Add pin/peripheral conflict solver with explicit diagnostics.
2. Add clock configuration model with rule validation.
3. Expand MCU catalog and board metadata, then verify project generation against each family.
4. Add middleware-specific advanced forms and `.ioc` mapping.
5. Add full regenerate path that preserves user-code regions and reports diffs.
