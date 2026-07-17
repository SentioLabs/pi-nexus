# Svelte / TypeScript AI Slop Signals

Language-specific signals for Svelte and TypeScript codebases. These supplement the
universal signals in SKILL.md — apply both.

## What idiomatic Svelte/TypeScript looks like

### Svelte 24.x LTS (Svelte 5)
- Runes: `$state`, `$derived`, `$effect` — no more `$:` reactive declarations
- `$props()` with typed interface — no more `export let`
- `$bindable()` for two-way binding props
- Snippets over slots for content composition
- `$inspect()` for debugging (dev-only)
- Fine-grained reactivity — no more immutable assignment patterns needed for arrays/objects

### TypeScript 5.9+
- `satisfies` operator for type narrowing without widening
- `using` declarations for resource management (Explicit Resource Management)
- `const` type parameters for literal inference
- `NoInfer<T>` utility type
- Discriminated unions over optional fields
- `readonly` on config/prop interfaces
- Template literal types for string validation

### SvelteKit patterns
- `+page.server.ts` load functions over `onMount` fetching
- Form actions over manual fetch POST
- `$page.data` for layout-shared data
- SvelteKit's `fetch` (not axios/node-fetch) — handles cookies, SSR, relative URLs
- `$env/static/private` for secrets (never in `+page.ts`)

### Project adaptation
Before flagging any idiom violation, check the project's baseline conventions.

## Priority order for Svelte/TypeScript

1. TypeScript type safety — any abuse, type assertions, missing discriminated unions
2. Svelte reactivity model — correct reactive updates, cleanup, binding usage
3. SvelteKit patterns — load functions, form actions, data flow
4. Component design — prop drilling, store usage, composition
5. Security — XSS via {@html}, client-side secrets

---

## TypeScript misuse

**`any` as an escape hatch:**
```typescript
// SLOP — gives up type safety entirely
const response: any = await fetch('/api/users');
const data: any = await response.json();

// IDIOMATIC — define the shape
interface User {
  id: string;
  name: string;
  email: string;
}
const response = await fetch('/api/users');
const data: User[] = await response.json();

// EVEN BETTER — runtime validation
const data = UserArraySchema.parse(await response.json());
```

**@ts-ignore without explanation:**
```typescript
// SLOP
// @ts-ignore
const result = thing.method();

// IF NECESSARY — explain why
// @ts-expect-error: library types are wrong, see https://github.com/lib/issues/123
const result = thing.method();
```

**Type assertions without runtime validation:**
```typescript
// SLOP — trusts external data blindly
const user = JSON.parse(body) as User;

// IDIOMATIC — validate at the boundary
const user = userSchema.parse(JSON.parse(body));
```

**Optionals everywhere instead of discriminated unions:**
```typescript
// SLOP — which combinations are valid? Who knows
interface ApiResponse {
  data?: User[];
  error?: string;
  loading?: boolean;
  total?: number;
}

// IDIOMATIC — each state is explicit
type ApiResponse =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'success'; data: User[]; total: number };
```

**Missing readonly:**
```typescript
// SLOP — props and config objects should be immutable
interface Config {
  apiUrl: string;
  timeout: number;
}

// IDIOMATIC
interface Config {
  readonly apiUrl: string;
  readonly timeout: number;
}
```

---

## Svelte reactivity model violations

**Using Svelte 4 reactive declarations instead of runes:**
```svelte
<script lang="ts">
// SLOP — Svelte 4 syntax, no longer idiomatic
export let count = 0;
$: doubled = count * 2;
$: if (count > 10) {
  console.log('count is big');
}

// IDIOMATIC — Svelte 5 runes
interface Props {
  count: number;
}
let { count }: Props = $props();
let doubled = $derived(count * 2);
$effect(() => {
  if (count > 10) {
    console.log('count is big');
  }
});
</script>
```

**Imperative mutation instead of reactive state:**
```svelte
<script lang="ts">
// SLOP — using $state but mutating without Svelte detecting it
let items: string[] = $state([]);
function addItem(item: string) {
  // In Svelte 5, $state makes arrays/objects deeply reactive,
  // so .push() DOES work. But creating new references is still
  // clearer for complex transformations.
  items = [...items, item];
}
</script>
```

**Missing $effect cleanup:**
```svelte
<script lang="ts">
// SLOP — interval never cleared, memory leak
$effect(() => {
  setInterval(pollData, 5000);
});

// IDIOMATIC — $effect return value is the cleanup function
$effect(() => {
  const interval = setInterval(pollData, 5000);
  return () => clearInterval(interval);
});
</script>
```

**Direct DOM manipulation bypassing Svelte:**
```svelte
<script lang="ts">
// SLOP — fighting the framework
import { onMount } from 'svelte';
onMount(() => {
  document.querySelector('.header')?.classList.add('active');
});

// IDIOMATIC — use Svelte bindings and class directives
let isActive = $state(false);
</script>
<div class="header" class:active={isActive}>
```

**Missing UI states — the classic AI tell:**
```svelte
<!-- SLOP — only shows data, no loading/error/empty states -->
{#if data}
  {#each data as item}
    <Card {item} />
  {/each}
{/if}

<!-- IDIOMATIC — handles all states -->
{#if loading}
  <Spinner />
{:else if error}
  <ErrorMessage {error} />
{:else if data.length === 0}
  <EmptyState />
{:else}
  {#each data as item}
    <Card {item} />
  {/each}
{/if}
```

---

## SvelteKit patterns

**Data fetching in onMount instead of load function:**
```svelte
<script lang="ts">
// SLOP — data fetched client-side only, no SSR, no loading state from SvelteKit
import { onMount } from 'svelte';
let users: User[] = $state([]);
onMount(async () => {
  const res = await fetch('/api/users');
  users = await res.json();
});
</script>
```

```typescript
// IDIOMATIC — in +page.ts or +page.server.ts
export const load = async ({ fetch }) => {
  const res = await fetch('/api/users');
  return { users: await res.json() };
};
```

**Not using SvelteKit's fetch:**
```typescript
// SLOP — loses cookie forwarding, SSR compatibility
import axios from 'axios';
const data = await axios.get('/api/data');

// IDIOMATIC — SvelteKit's fetch handles cookies, SSR, and relative URLs
export const load = async ({ fetch }) => {
  const res = await fetch('/api/data');
  return { data: await res.json() };
};
```

**Manual form handling instead of form actions:**
```svelte
<!-- SLOP — reinventing what SvelteKit provides, using Svelte 4 event syntax -->
<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
  <input bind:value={name} />
  <button>Submit</button>
</form>

<script lang="ts">
let name = $state('');
async function handleSubmit() {
  await fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}
</script>
```

```typescript
// IDIOMATIC — in +page.server.ts
export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    const name = data.get('name');
    // validate and save
  }
};
```

**Ignoring layout data and page stores:**
- Not using `$page.data` for shared data from layout load functions
- Not using `$navigating` for navigation state
- Duplicating data fetching that a parent layout already provides

---

## Component design

**Prop drilling (4+ levels):**
```svelte
<!-- SLOP — passing theme through every intermediate component -->
<App {theme}>
  <Layout {theme}>
    <Sidebar {theme}>
      <NavItem {theme} />

<!-- IDIOMATIC — use Svelte context -->
<!-- App.svelte -->
<script lang="ts">
import { setContext } from 'svelte';
setContext('theme', theme);
</script>

<!-- NavItem.svelte -->
<script lang="ts">
import { getContext } from 'svelte';
const theme = getContext<Theme>('theme');
</script>
```

**One-off component duplication:**
If a component exists that does 90% of what's needed, and AI created a new component
with 90% identical code plus a small variation — that's slop. The existing component
should be extended with a prop or snippet.

**Untyped props and events:**
```svelte
<script lang="ts">
// SLOP — no types on props
let { data, onSubmit } = $props();

// IDIOMATIC — typed interface with $props()
interface Props {
  readonly data: User;
  onSubmit: (user: User) => void;
}
let { data, onSubmit }: Props = $props();
</script>
```

**Using `export let` (Svelte 4 legacy):**
```svelte
<script lang="ts">
// SLOP — Svelte 4 prop declaration, no longer idiomatic
export let user: User;
export let onSave: (user: User) => void;

// IDIOMATIC — Svelte 5 $props() with typed interface
interface Props {
  readonly user: User;
  onSave: (user: User) => void;
}
let { user, onSave }: Props = $props();
</script>
```

---

## Security signals

**XSS via {@html}:**
```svelte
<!-- CRITICAL — user content rendered as raw HTML -->
{@html userComment}

<!-- SAFE — Svelte auto-escapes by default in text content -->
{userComment}
```

**Client-side secrets:**
```typescript
// SLOP — exposed to the browser
const API_KEY = 'sk-1234567890';

// IDIOMATIC — server-side only, in +page.server.ts or via $env/static/private
import { API_KEY } from '$env/static/private';
```

- Any `import` from `$env/static/private` in a `+page.ts` (non-server) file
- API keys in `.env` without the `PUBLIC_` prefix that are used client-side
- Sensitive data in `+page.ts` load functions instead of `+page.server.ts`

---

## TypeScript-specific test signals

- Tests that use `as any` to bypass type errors instead of providing proper test data
- No `vitest` or `playwright` in a SvelteKit project (the default test runners)
- Component tests that only check rendering, not interaction or state changes
- Missing `@testing-library/svelte` patterns — testing implementation details instead of behavior
- No type-level tests for discriminated unions and conditional types
- E2E tests that use `data-testid` on everything instead of accessible selectors
