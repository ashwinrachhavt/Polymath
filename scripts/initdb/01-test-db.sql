-- Runs on first container boot (docker-entrypoint-initdb.d): creates the
-- scratch database the integration suites truncate.
CREATE DATABASE axiom_test;
GRANT ALL PRIVILEGES ON DATABASE axiom_test TO axiom;
