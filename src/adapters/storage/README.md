# Persistence adapter

Implementation wave W1.

MVP target: SQLite WAL with append-only transition/event history plus normalized current-state tables. Repository contracts must keep a future PostgreSQL migration local to this adapter.
