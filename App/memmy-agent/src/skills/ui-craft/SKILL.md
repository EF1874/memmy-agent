---
name: ui-craft
description: Design, build, or modify browser-visible web interfaces with implementation-quality UI and browser visual QA. Use for HTML, CSS, JavaScript, React, Vue, or Svelte pages and components, landing pages, dashboards, forms, responsive layouts, and any frontend change that alters visible browser output.
---

# UI Craft

Build coherent, intentional interfaces that fit the existing product and work in a real browser.

## Understand the interface

1. Inspect the current page, nearby components, design tokens, assets, and project conventions before editing.
2. Preserve the established component system and brand language unless the request explicitly calls for a redesign.
3. Identify the page hierarchy, primary user action, important states, responsive constraints, and accessibility requirements.

## Design and implement

- Establish clear visual hierarchy through scale, spacing, alignment, contrast, and restrained emphasis.
- Use a deliberate typography and color system. Reuse project tokens instead of introducing nearly identical values.
- Make interactive states complete: default, hover, focus, active, disabled, loading, empty, success, and error where applicable.
- Keep controls discoverable, labels unambiguous, focus visible, semantics meaningful, and contrast sufficient.
- Verify layouts at relevant viewport sizes. Prevent clipping, overlap, unintended overflow, and unusable touch targets.
- Prefer a small number of strong visual decisions over decorative noise, excessive cards, arbitrary gradients, or generic placeholder styling.
- Implement the real runnable interface. Do not substitute a mock screenshot, prose description, or disconnected static sample for working code.
- Keep changes scoped to the requested interface and avoid rewriting unrelated components or global styling.

## Browser visual QA

When the `browser_*` tools are available, complete this sequence before declaring the frontend work finished:

1. Start the page with the project's existing development or preview command.
2. Use `browser_navigate` to open the actual page.
3. Use `browser_snapshot` to inspect structure, content, and important controls.
4. Use `browser_console_messages` to inspect errors and warnings.
5. Use `browser_network_requests` to inspect failed or unexpected requests.
6. Use `browser_take_screenshot` and visually inspect the rendered result.
7. Fix material problems and repeat the complete sequence until the page is sound.

Do not claim browser observations that were not performed. If browser tools are unavailable, explicitly report that browser validation was not performed; static checks are useful but do not replace visual QA.
