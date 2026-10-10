-- meet_user as Meet v1.19 migrates it: ghcr.io/linto-ai/meet-backend:v1.19
-- (sha256:ae534379e5329f3d069df08af7ecaf7a6f3256c77d0ced7bbdf9c01287383c27),
-- dumped with pg_dump --schema-only -t meet_user.

CREATE TABLE public.meet_user (
    password character varying(128) NOT NULL,
    last_login timestamp with time zone,
    is_superuser boolean NOT NULL,
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    sub character varying(255),
    email character varying(254),
    admin_email character varying(254),
    language character varying(10) NOT NULL,
    timezone character varying(63) NOT NULL,
    is_device boolean NOT NULL,
    is_staff boolean NOT NULL,
    is_active boolean NOT NULL,
    full_name character varying(100),
    short_name character varying(100),
    default_room_access_level character varying(50),
    default_room_configuration jsonb NOT NULL
);

ALTER TABLE ONLY public.meet_user
    ADD CONSTRAINT meet_user_admin_email_key UNIQUE (admin_email);

ALTER TABLE ONLY public.meet_user
    ADD CONSTRAINT meet_user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.meet_user
    ADD CONSTRAINT meet_user_sub_key UNIQUE (sub);

CREATE INDEX meet_user_admin_email_47b33303_like ON public.meet_user USING btree (admin_email varchar_pattern_ops);

CREATE INDEX meet_user_sub_15198d46_like ON public.meet_user USING btree (sub varchar_pattern_ops);

CREATE UNIQUE INDEX unique_email_when_sub_is_null ON public.meet_user USING btree (lower((email)::text)) WHERE (sub IS NULL);

