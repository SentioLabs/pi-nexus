# Go AI Slop Signals

Language-specific signals for Go codebases. These supplement the universal signals
in SKILL.md — apply both.

## What idiomatic Go looks like

### At version 1.26+
- `log/slog` for structured logging (stdlib since 1.21)
- Range-over-func iterators (since 1.23)
- Generic `slices`/`maps` functions over hand-rolled loops
- `cmp.Or` for default values
- Structured concurrency patterns with `errgroup`
- `maps.Clone`, `slices.Concat`, `slices.Contains` etc.
- New `http.ServeMux` with method-based routing (1.22+)

### Stdlib preferences
- Logging: `log/slog` over `log` or third-party loggers in new code
- Slices: `slices` package over manual loops for search/sort/compare
- Maps: `maps` package for clone/keys/values operations
- HTTP: `http.NewServeMux` patterns with method routing (1.22+)
- Testing: `testing.TB` helpers, `t.Cleanup` over deferred cleanup

### Error handling convention
- Always wrap errors with `fmt.Errorf("context: %w", err)`
- Use `errors.Is`/`errors.As` for comparison, never string matching
- Return errors to caller, don't `log.Fatal` in library/handler code
- Sentinel errors for expected conditions, wrapped errors for unexpected

### Project adaptation
Before flagging any idiom violation, check if the project's idiom baseline uses a different convention. The baseline overrides these defaults.

---

## Priority order for Go

1. Error handling — this is where AI Go code fails most visibly
2. Context propagation — threading context.Context correctly
3. Concurrency — goroutine lifecycle, channel ownership, sync primitives
4. Interface and type design — idiomatic Go vs. Java-in-Go
5. Testing — table-driven tests, test helpers, subtests

---

## Error handling (highest priority)

This is the single biggest tell in AI-generated Go. Humans who write Go daily internalize
error handling patterns; AI frequently gets them subtly wrong.

**Fatal/print instead of return:**
```go
// SLOP — log.Fatal in a library or handler function
if err != nil {
    log.Fatal(err)
}

// SLOP — fmt.Println for errors
if err != nil {
    fmt.Println("error:", err)
}

// IDIOMATIC — return the error to the caller
if err != nil {
    return fmt.Errorf("fetching user %d: %w", id, err)
}
```

**Missing error wrapping:**
```go
// SLOP — no context, breaks error unwrapping
if err != nil {
    return err
}

// SLOP — wraps but without %w, breaks errors.Is/As
if err != nil {
    return fmt.Errorf("failed to connect: %v", err)
}

// IDIOMATIC
if err != nil {
    return fmt.Errorf("connecting to %s: %w", addr, err)
}
```

**String comparison on errors:**
```go
// SLOP
if err.Error() == "not found" {
    // ...
}

// IDIOMATIC
if errors.Is(err, ErrNotFound) {
    // ...
}
```

**Swallowed errors:**
```go
// SLOP — error silently discarded
result, _ := doSomething()
```

---

## Context propagation

**Missing context.Context in signatures:**
```go
// SLOP — no context parameter
func FetchUser(id int) (*User, error) {

// IDIOMATIC — context is first parameter
func FetchUser(ctx context.Context, id int) (*User, error) {
```

**context.Background() mid-callstack:**
```go
// SLOP — creates a new root context deep in the call chain
func (s *Service) Process(data []byte) error {
    ctx := context.Background()  // should come from caller
    return s.store.Save(ctx, data)
}
```

**No cancellation handling:**
```go
// SLOP — ignores context cancellation
func worker(ctx context.Context) {
    for {
        doWork()
        time.Sleep(time.Second)
    }
}

// IDIOMATIC
func worker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            doWork()
        }
        select {
        case <-ctx.Done():
            return
        case <-time.After(time.Second):
        }
    }
}
```

---

## Concurrency

**Goroutine leaks — no cancellation path:**
```go
// SLOP — goroutine runs forever, no way to stop it
go func() {
    for {
        process(queue)
    }
}()

// IDIOMATIC — cancellable via context
go func() {
    for {
        select {
        case <-ctx.Done():
            return
        case item := <-queue:
            process(item)
        }
    }
}()
```

**Channel ownership confusion:**
- Channel created by one goroutine, closed by another (race condition risk)
- Channel created but never closed (goroutines blocked on range forever)
- Unbuffered channel used where buffered is needed (deadlock risk)

**sync.Mutex overuse:**
```go
// SLOP — mutex protecting a counter that should use atomic
var mu sync.Mutex
var count int

// BETTER
var count atomic.Int64
```

**sync.Mutex where single-goroutine ownership works:**
If a struct is only accessed from one goroutine, it doesn't need a mutex.
AI often adds mutexes "just in case" — a strong slop signal.

---

## Type and interface misuse

**Interface defined in the wrong package:**
```go
// SLOP — interface defined next to its implementation
// (Go convention: interfaces belong in the consuming package)
type UserStore interface {
    GetUser(ctx context.Context, id int) (*User, error)
}

type userStore struct { ... }
func (s *userStore) GetUser(...) { ... }
```

**Premature interface:**
```go
// SLOP — interface with exactly one implementation and one consumer
type Processor interface {
    Process(data []byte) error
}
```

**`interface{}` instead of `any`, or `any` instead of generics:**
```go
// SLOP — interface{} is an alias for any since 1.18; using the old syntax is dated
func Contains(slice []interface{}, item interface{}) bool {

// STILL SLOP at 1.26+ — hand-rolled contains; use slices.Contains
func Contains[T comparable](slice []T, item T) bool {

// IDIOMATIC at 1.26+ — use the stdlib slices package
import "slices"
found := slices.Contains(slice, item)
```

**Value receiver on mutating method:**
```go
// SLOP — s is a copy, mutation is lost
func (s Service) SetTimeout(d time.Duration) {
    s.timeout = d
}

// CORRECT
func (s *Service) SetTimeout(d time.Duration) {
    s.timeout = d
}
```

---

## Other Go idioms

**defer inside a loop:**
```go
// SLOP — defers accumulate until function return, not loop iteration
for _, f := range files {
    fd, _ := os.Open(f)
    defer fd.Close()  // all closes happen at function exit
}

// CORRECT — extract to helper or close explicitly
for _, f := range files {
    if err := processFile(f); err != nil {
        return err
    }
}
```

**Hand-rolled slice/map operations (1.26+):**
```go
// SLOP — manual contains check
found := false
for _, v := range items {
    if v == target {
        found = true
        break
    }
}

// IDIOMATIC at 1.26+ — use slices package
found := slices.Contains(items, target)

// SLOP — manual sort
sort.Slice(items, func(i, j int) bool { return items[i] < items[j] })

// IDIOMATIC at 1.26+
slices.Sort(items)

// SLOP — manual map key collection
keys := make([]string, 0, len(m))
for k := range m {
    keys = append(keys, k)
}

// IDIOMATIC at 1.26+
keys := slices.Collect(maps.Keys(m))
```

**Old-style logging instead of slog (1.26+):**
```go
// SLOP in new code — unstructured logging
log.Printf("user %d logged in from %s", id, ip)

// IDIOMATIC at 1.26+ — structured logging with log/slog
slog.Info("user logged in", "user_id", id, "ip", ip)
```

**Default value chains without cmp.Or (1.26+):**
```go
// SLOP — verbose conditional default
port := os.Getenv("PORT")
if port == "" {
    port = "8080"
}

// IDIOMATIC at 1.26+
port := cmp.Or(os.Getenv("PORT"), "8080")
```

**HTTP server without timeouts:**
```go
// SLOP
http.ListenAndServe(":8080", handler)

// IDIOMATIC at 1.26+ — use method-based routing on ServeMux
mux := http.NewServeMux()
mux.HandleFunc("GET /users/{id}", getUser)
mux.HandleFunc("POST /users", createUser)

srv := &http.Server{
    Addr:         ":8080",
    Handler:      mux,
    ReadTimeout:  15 * time.Second,
    WriteTimeout: 15 * time.Second,
    IdleTimeout:  60 * time.Second,
}
srv.ListenAndServe()
```

**Global singletons via init():**
```go
// SLOP
var db *sql.DB

func init() {
    var err error
    db, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }
}

// BETTER — dependency injection, initialized in main()
```

---

## Security signals

- SQL via `fmt.Sprintf` instead of parameterized queries (`db.Query(query, args...)`)
- `http.ListenAndServe` with no TLS and no reverse proxy documented
- `os/exec.Command` with user input concatenated into the command string
- `http.Get` / `http.Post` with no timeout (uses `http.DefaultClient` which has no timeout)

---

## Go-specific test signals

**Not using table-driven tests** — the canonical Go testing pattern:
```go
// SLOP — separate test functions for each case
func TestParseValid(t *testing.T) { ... }
func TestParseEmpty(t *testing.T) { ... }
func TestParseInvalid(t *testing.T) { ... }

// IDIOMATIC
func TestParse(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    Result
        wantErr bool
    }{
        {"valid", "good", Result{...}, false},
        {"empty", "", Result{}, true},
        {"invalid", "bad", Result{}, true},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := Parse(tt.input)
            // ...
        })
    }
}
```

- `t.Log` / `fmt.Println` instead of assertion — test always passes
- No `t.Helper()` on test helper functions (error locations point to helper, not caller)
- No `t.Parallel()` on tests that are safe to parallelize
- `testify` used in a codebase that uses stdlib `testing` everywhere else (or vice versa)
