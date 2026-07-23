// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

// Tells React's `act()` that this jsdom environment is a supported test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
