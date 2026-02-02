# Database Migrations

Run these migrations in order using your preferred migration tool or psql.

## Manual execution with psql:

```bash
psql $DATABASE_URL -f migrations/001_create_review_sms_log.sql
psql $DATABASE_URL -f migrations/002_create_sms_opt_out.sql
```

## Or using a migration tool:

If you're using a migration tool like `node-pg-migrate`, `knex`, or `db-migrate`, convert these SQL files accordingly.

