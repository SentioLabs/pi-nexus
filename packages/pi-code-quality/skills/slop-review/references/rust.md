# Rust AI Slop Signals

Language-specific signals for Rust codebases. These supplement the universal signals
in SKILL.md — apply both.

## What idiomatic Rust looks like

### At version 1.94+ (Edition 2024)
- `async fn` in traits — no more `async-trait` crate for simple cases
- `impl Trait` in more return positions
- `LazyLock`/`LazyCell` from stdlib over `once_cell`/`lazy_static` crates
- Let chains for cleaner pattern matching
- `#[must_use]` on fallible functions and important return values
- `#[diagnostic::on_unimplemented]` for better error messages on traits

### Stdlib preferences
- Lazy init: `std::sync::LazyLock` over `once_cell::sync::Lazy`
- Error types: `thiserror` for library errors, `anyhow`/`eyre` for application errors
- Async runtime: `tokio` (check project convention)
- Serialization: `serde` with derive macros
- CLI: `clap` with derive macros

### Error handling convention
- `?` propagation, never manual `match Ok/Err` for simple forwarding
- Typed error enums with `thiserror` in library code
- `anyhow::Result` acceptable in binary/CLI code, not libraries
- `expect()` only in `main()` or provably unreachable paths
- `unwrap()` only in tests

### Type system usage
- Enums over bools for state/mode parameters
- Newtype pattern for domain values (UserId, OrderId)
- `From`/`Into` implementations for error conversion
- `Default` derive when obvious default exists
- Private fields with public constructors for invariant enforcement

### Project adaptation
Before flagging any idiom violation, check if the project's baseline uses different conventions.

---

## Priority order for Rust

1. Error handling — unwrap/expect abuse, missing ? propagation
2. Ownership and borrowing — clone storms, RefCell overuse
3. Type system usage — enums vs. bools, newtypes, trait implementations
4. Unsafe and panic safety — library code that panics or uses unsafe carelessly
5. Clippy and tooling — suppressed warnings, unnecessary pub visibility

---

## Error handling (highest priority)

**unwrap() outside of tests:**
```rust
// SLOP — panics in production on any failure
let config = read_config().unwrap();
let conn = db.connect().unwrap();

// IDIOMATIC — propagate with ?
let config = read_config()?;
let conn = db.connect().context("connecting to database")?;
```

**expect() as a substitute for error propagation:**
```rust
// SLOP — slightly better than unwrap but still panics
let user = find_user(id).expect("user should exist");

// expect() is OK for genuinely unrecoverable cases in main() or bootstrap
// but not in library code or request handlers
```

**Box<dyn Error> in library code:**
```rust
// SLOP — erases the error type, consumers can't match on it
fn process(data: &[u8]) -> Result<Output, Box<dyn Error>> {

// IDIOMATIC — typed error enum (thiserror)
#[derive(Debug, thiserror::Error)]
enum ProcessError {
    #[error("invalid format: {0}")]
    InvalidFormat(String),
    #[error("io error")]
    Io(#[from] std::io::Error),
}

fn process(data: &[u8]) -> Result<Output, ProcessError> {
```

**Not using ? propagation:**
```rust
// SLOP — manual match on every Result
let data = match read_file(path) {
    Ok(d) => d,
    Err(e) => return Err(e.into()),
};

// IDIOMATIC
let data = read_file(path)?;
```

---

## Borrow checker fights

**Excessive .clone() — the #1 Rust slop signal:**
```rust
// SLOP — cloning to avoid borrow checker errors
fn process(items: &[Item]) -> Vec<Output> {
    let cloned = items.to_vec();  // unnecessary clone
    cloned.iter().map(|item| {
        let name = item.name.clone();  // another unnecessary clone
        transform(name)
    }).collect()
}
```

When you see `.clone()` more than once or twice in a function, check whether
ownership could be restructured instead. Some clones are necessary and correct —
the signal is *pervasive* cloning as a pattern.

**Rc<RefCell<T>> when ownership could be restructured:**
```rust
// SLOP — interior mutability as a crutch
let shared_state = Rc::new(RefCell::new(State::new()));

// Often the real fix is restructuring so one owner holds the state
// and others get references or communicate via channels
```

Note: with Edition 2024, `async fn` in traits eliminates some cases where
`Rc<RefCell<T>>` was used as a workaround for trait object limitations in
async code. If you see this pattern in async trait implementations, check
whether native `async fn` in traits makes it unnecessary.

**Arc<Mutex<T>> overuse:**
Same pattern as Rc<RefCell<T>> but in async/threaded code. If every piece of
shared state is behind Arc<Mutex<T>>, the author likely fought the borrow checker
rather than designing for ownership.

---

## Type system underuse

**Bool flags instead of enums:**
```rust
// SLOP — what does (true, false) mean?
fn create_user(name: &str, is_admin: bool, is_active: bool) -> User {

// IDIOMATIC — illegal states unrepresentable
enum Role { Admin, User }
enum Status { Active, Inactive }
fn create_user(name: &str, role: Role, status: Status) -> User {
```

**Stringly-typed state:**
```rust
// SLOP
fn set_status(status: &str) {
    match status {
        "active" | "inactive" | "pending" => { ... }
        _ => panic!("invalid status"),  // runtime error for a compile-time problem
    }
}

// IDIOMATIC
enum Status { Active, Inactive, Pending }
fn set_status(status: Status) { ... }
```

**Missing standard trait implementations:**
- `Debug` derived but `Display` not implemented (users see `MyError { kind: ... }` instead of a message)
- No `From`/`Into` implementations for error types (forces manual conversion everywhere)
- No `Default` when there's an obvious default configuration
- Missing `Clone`, `PartialEq`, `Hash` on types that clearly need them

**Raw primitives for domain values:**
```rust
// SLOP — easy to pass user_id where order_id is expected
fn get_order(user_id: u64, order_id: u64) -> Order {

// IDIOMATIC — newtype pattern
struct UserId(u64);
struct OrderId(u64);
fn get_order(user_id: UserId, order_id: OrderId) -> Order {
```

---

## Unsafe and panic safety

**Unsafe without SAFETY comment:**
```rust
// SLOP
unsafe {
    ptr::write(dest, value);
}

// REQUIRED
// SAFETY: dest is guaranteed to be valid and aligned because
// it was allocated by Vec::with_capacity and index < len.
unsafe {
    ptr::write(dest, value);
}
```

**Panicking in library code:**
- `panic!()`, `unreachable!()`, `todo!()` in non-test code
- `.unwrap()` on user-influenced data paths
- `assert!()` for input validation (use `Result` instead)
- Array indexing without bounds checks where the index comes from external input

**transmute without justification:**
`std::mem::transmute` should be extremely rare and always documented. If AI generated
a transmute, it almost certainly found a Stack Overflow answer from 2016 and
copy-pasted it.

---

## Build and tooling signals

**`lazy_static!` or `once_cell` for lazy initialization (Edition 2024+):**
```rust
// SLOP — unnecessary third-party crate since Rust 1.80+
use lazy_static::lazy_static;
lazy_static! {
    static ref CONFIG: Config = load_config();
}

// SLOP — same issue with once_cell
use once_cell::sync::Lazy;
static CONFIG: Lazy<Config> = Lazy::new(|| load_config());

// IDIOMATIC — stdlib LazyLock (stable since 1.80, preferred in Edition 2024)
use std::sync::LazyLock;
static CONFIG: LazyLock<Config> = LazyLock::new(|| load_config());
```

If you see `lazy_static` or `once_cell::sync::Lazy` in new code targeting
Rust 1.80+, flag it. For `once_cell::sync::OnceCell`, the stdlib equivalent
is `std::sync::OnceLock`. Existing projects may still use the crates for MSRV
reasons — check `Cargo.toml` for `rust-version` before flagging.

**`async-trait` crate in Edition 2024 code:**
```rust
// SLOP — unnecessary with native async fn in traits (Edition 2024)
#[async_trait]
trait MyService {
    async fn handle(&self) -> Result<()>;
}

// IDIOMATIC — native async fn in traits
trait MyService {
    async fn handle(&self) -> Result<()>;
}
```

The `async-trait` crate is still needed for `dyn Trait` usage or when trait
objects require `Send` bounds that native async traits don't yet handle well.
Flag it only when the trait is used with static dispatch (generics/`impl Trait`).

**Suppressed warnings:**
```rust
// SLOP — hiding problems instead of fixing them
#[allow(unused_variables)]
#[allow(dead_code)]
#[allow(unused_imports)]
```

A few `#[allow]` annotations are normal. Dozens scattered across a file means the
code was generated and then warnings were suppressed to make it compile.

**Over-broad pub visibility:**
```rust
// SLOP — everything public for no reason
pub struct Config {
    pub db_url: String,
    pub db_pool_size: u32,
    pub secret_key: String,  // this should NOT be pub
}
```

In idiomatic Rust, items are private by default and only made `pub` when needed
by the module's public API. If every struct, field, function, and module is `pub`,
it's likely AI-generated with no thought about encapsulation.

---

## Rust-specific test signals

- No `#[should_panic]` or explicit error matching on tests for error paths
- `assert!(result.is_ok())` instead of `let value = result.unwrap()` + assertions on value
- Tests that don't use `#[test]` helper patterns (common setup extracted to functions)
- Integration tests in `src/` instead of `tests/` directory
- No `proptest` or `quickcheck` where the function has clear algebraic properties
