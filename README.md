# TovaIDE-STM

A VS Code fork specialized for STM32 microcontroller development.

## What is this?

TovaIDE-STM is an integrated development environment based on VS Code with added features for STM32 development.

**For detailed usage instructions, see the [User Guide](https://rintaro-s.github.io/TovaIDE-STM/getting-started.html).**

## Key Components

- `extensions/stm32-core`: Build, flash programming, debugging, CubeMX/CubeCLT integration
- `extensions/stm32-ai`: AI assistant, MCP, build error analysis
- `extensions/stm32-ux`: Welcome wizard, environment check, pin visualizer
- `extensions/stm32-collab`: Collaboration features (disabled in current release)

## Quick Start

### Prerequisites

- Node.js and npm
- Git
- STM32CubeCLT
- arm-none-eabi-gcc
- ST-LINK driver

### Development Setup

```powershell
npm install
npm run electron
npm run watch
.\scripts\code.bat
```

### Available Tasks

- `VS Code - Build`: Compile the IDE
- `Run Dev`: Launch development version
- `Run Dev Sessions`: Launch with sessions support

## Usage

For complete usage documentation including:
- Installation and setup
- Creating and importing projects
- Building and debugging
- Using the pin visualizer
- Troubleshooting

**Visit: [https://rintaro-s.github.io/TovaIDE-STM/getting-started.html](https://rintaro-s.github.io/TovaIDE-STM/getting-started.html)**

## Repository Structure

```text
extensions/stm32-core      STM32 build, flash, debug
extensions/stm32-ai        AI assistant and MCP
extensions/stm32-ux        Welcome wizard and tools
extensions/stm32-collab    Collaboration features
src/                       VS Code core modifications
resources/stm32/           Templates, SVD files, MCU definitions
scripts/                   Launch scripts
build/                     Build scripts
```

## Development Commands

```powershell
npm run compile-check-ts-native    # Type check
npm run eslint                      # Lint
npm run hygiene                     # Code hygiene
npm run valid-layers-check          # Layer validation
.\scripts\test.bat                  # Unit tests
npm run test-browser                # Browser tests
npm run smoketest                   # Smoke tests
```

