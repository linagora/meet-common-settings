-- The role the service runs as in production, with the same grants.
CREATE ROLE meet_side_service WITH LOGIN PASSWORD 'dev';
GRANT CONNECT ON DATABASE meet TO meet_side_service;
GRANT USAGE ON SCHEMA public TO meet_side_service;
GRANT SELECT (email, updated_at), UPDATE (language, timezone, updated_at)
  ON meet_user TO meet_side_service;

-- Django fills these columns itself, so the table has no defaults for them.
INSERT INTO meet_user
  (id, sub, email, password, is_superuser, is_device, is_staff, is_active,
   language, timezone, default_room_configuration, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'alice', 'Alice@example.com', '', false, false, false, true,
   'en-us', 'UTC', '{}', now() - interval '1 hour', now() - interval '1 hour'),
  (gen_random_uuid(), 'bob', 'bob@example.com', '', false, false, false, true,
   'fr-fr', 'Europe/Paris', '{}', now() - interval '1 hour', now() - interval '1 hour'),
  (gen_random_uuid(), 'carol', 'carol@example.com', '', false, false, false, true,
   'en-us', 'America/New_York', '{}', now() - interval '1 hour', now() - interval '1 hour');
