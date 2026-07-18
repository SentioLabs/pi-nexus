# Python AI Slop Signals

Language-specific signals for Python codebases. These supplement the universal signals
in SKILL.md — apply both.

## What idiomatic Python looks like

### At version 3.13+

- Union types: `X | None` not `Optional[X]`, `X | Y` not `Union[X, Y]`
- Built-in generics: `list[str]` not `typing.List[str]`, `dict[str, int]` not `typing.Dict[str, int]`
- `@deprecated` decorator from `warnings`
- `StrEnum` for string enumerations (stdlib since 3.11)
- `tomllib` for TOML parsing (stdlib since 3.11)
- `ExceptionGroup` and `except*` for concurrent error handling
- Walrus operator `:=` where it reduces duplication
- Per-interpreter GIL / free-threaded mode awareness

### Stdlib preferences

- Filesystem: `pathlib.Path` over `os.path` in new code
- Caching: `functools.cache` (3.9+) or `lru_cache` over hand-rolled memoization
- Data containers: `dataclasses` or `NamedTuple` over plain dicts for structured data
- Iteration: `itertools` (product, chain, groupby) over nested manual loops
- Context managers: `contextlib.contextmanager` over manual `__enter__`/`__exit__`
- Temporary files: `tempfile` with context managers, never hardcoded paths

### Error handling convention

- Specific exceptions over bare `except Exception`
- `raise X from e` to preserve tracebacks
- EAFP for duck typing, LBYL for everything else
- `.get()` over try/except KeyError for dict access

### Project adaptation

Before flagging any idiom violation, check if the project's idiom baseline (from Step 0)
uses a different convention. The baseline overrides these defaults.

---

## Priority order for Python

1. Error handling — bare excepts, swallowed errors, exceptions for control flow
2. Idiomatic Python — are they writing Python or Java-in-Python?
3. Type system usage — modern typing vs. no types vs. over-typed
4. Async correctness — if async is used, is it used properly?
5. Security — eval, exec, shell injection, pickle

---

## Error handling

**Bare exception swallowing** — the single most common AI Python tell:
```python
# SLOP: silent failure
try:
    result = do_thing()
except Exception:
    pass

# SLOP: catching too broadly then re-raising generically
try:
    data = parse(raw)
except Exception as e:
    raise ValueError(f"Parse failed: {e}")  # loses traceback, catches too much

# BETTER: specific exceptions, context preserved
try:
    data = parse(raw)
except json.JSONDecodeError as e:
    raise ParseError(f"Invalid JSON at position {e.pos}") from e
```

**Exceptions for control flow** — using try/except where a conditional or `.get()` works:
```python
# SLOP
try:
    value = data["key"]
except KeyError:
    value = default

# IDIOMATIC
value = data.get("key", default)
```

**Over-defensive error handling** — wrapping operations that cannot fail:
```python
# SLOP: len() on a list cannot raise
try:
    count = len(items)
except Exception:
    count = 0
```

---

## Classic footguns AI still produces

**Mutable default arguments:**
```python
# SLOP — the list is shared across all calls
def append_to(item, target=[]):
    target.append(item)
    return target

# CORRECT
def append_to(item, target=None):
    if target is None:
        target = []
    target.append(item)
    return target
```

**Global state as a crutch:**
```python
# SLOP
_cache = {}
def get_user(user_id):
    global _cache
    if user_id not in _cache:
        _cache[user_id] = fetch(user_id)
    return _cache[user_id]

# BETTER: encapsulate state, or use functools.lru_cache
```

**Resources without context managers:**
```python
# SLOP
f = open("data.csv")
data = f.read()
f.close()

# IDIOMATIC
with open("data.csv") as f:
    data = f.read()
```

---

## Type and style signals

**Missing or outdated type hints** — with 3.13+ as the minimum floor, these are all
non-idiomatic and should be flagged:
- No type hints at all on function signatures
- `Optional[X]` instead of `X | None` — the `Optional` alias is legacy
- `typing.List`, `typing.Dict`, `typing.Tuple`, `typing.Set` instead of `list`, `dict`, `tuple`, `set` — built-in generics have been available since 3.9
- `typing.Union[X, Y]` instead of `X | Y` — the pipe syntax has been available since 3.10
- Importing from `typing` for constructs that now live in the stdlib (e.g., `typing.NamedTuple` when `typing` import is the only reason)

**isinstance chains instead of structural typing:**
```python
# SLOP
def process(item):
    if isinstance(item, str):
        return handle_str(item)
    elif isinstance(item, int):
        return handle_int(item)
    elif isinstance(item, list):
        return handle_list(item)

# BETTER: Protocol, singledispatch, or rethink the interface
```

**Avoiding the stdlib:**
- `os.path.join` instead of `pathlib.Path` in new code
- Manual iteration instead of `itertools` (product, chain, groupby)
- Hand-rolled memoization instead of `functools.lru_cache` or `cache`
- Manual context managers instead of `contextlib.contextmanager`
- Custom data containers instead of `dataclasses` or `NamedTuple`
- `collections.OrderedDict` in Python 3.7+ (regular dicts are ordered)

**`*args, **kwargs` on internal functions:**
```python
# SLOP — lazy interface design, impossible to type-check
def create_user(*args, **kwargs):
    return User(*args, **kwargs)

# BETTER: explicit parameters with types
def create_user(name: str, email: str, role: Role = Role.USER) -> User:
    return User(name=name, email=email, role=role)
```

---

## Async signals

**Blocking calls in async code** — the most insidious AI async mistake:
```python
# SLOP — requests blocks the event loop
async def fetch_data(url):
    response = requests.get(url)  # BLOCKS
    return response.json()

# SLOP — time.sleep blocks the event loop
async def poll():
    while True:
        await check()
        time.sleep(5)  # BLOCKS — should be await asyncio.sleep(5)
```

**Deprecated async patterns:**
```python
# SLOP (deprecated since 3.10)
loop = asyncio.get_event_loop()
loop.run_until_complete(main())

# IDIOMATIC
asyncio.run(main())
```

**Missing await** — code runs but the coroutine never executes:
```python
# SLOP — result is a coroutine object, not the actual result
async def process():
    result = fetch_data()  # missing await
    return result
```

---

## Security signals

These are serious — flag as Critical regardless of other context:

- `eval()` or `exec()` on any external or user-influenced input
- Shell commands with `shell=True` and string formatting for the command
- `pickle.loads()` / `pickle.load()` on untrusted data
- Secrets in default argument values, module-level constants, or committed `.env` files
- `yaml.load()` without `Loader=SafeLoader` (allows arbitrary code execution)
- SQL built via f-strings or `.format()` instead of parameterized queries
- `hashlib.md5()` or `hashlib.sha1()` for security purposes (use sha256+)
- `random` module for security-sensitive values (use `secrets` module)

---

## Python-specific test signals

- `unittest.TestCase` subclasses in a project that uses `pytest` everywhere else
- `mock.patch` on everything — tests that mock the entire world test nothing
- No `parametrize` / `params` where the function has obvious input variations
- `assert result is not None` as the only assertion (proves nothing about correctness)
- Test files that import and call the function but don't assert meaningful behavior
- `conftest.py` with fixtures that do too much setup (hiding test complexity)
- No `tmp_path` or `tmp_path_factory` — tests writing to fixed filesystem paths

---

## Framework-specific notes

Be aware that some frameworks have conventions that look unusual:

- **Dagster:** `@asset` decorators, `@op`, resource injection via type annotations,
  `MaterializeResult` returns. These are framework conventions, not slop.
- **Django:** Class-based views, `Meta` inner classes, `models.Manager` subclasses.
- **FastAPI:** `Depends()` injection, Pydantic models for validation, `async def` route
  handlers that may legitimately use sync ORM calls via `run_in_executor`.
- **SQLAlchemy:** `Column()`, `relationship()`, declarative base patterns.
- **Pydantic:** `model_validator`, `field_validator`, `ConfigDict` — these are idiomatic.

Don't flag framework-conventional patterns. Do flag when framework patterns are mixed
incorrectly (e.g., raw SQL in a project that uses SQLAlchemy ORM everywhere else).
