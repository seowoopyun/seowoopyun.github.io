const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./index-zd53BzQ3.js","./index-CgIcxmn-.js","./index-albShrnE.css"])))=>i.map(i=>d[i]);
import{_ as w}from"./index-CgIcxmn-.js";const x=`-- 2-3반 함께 공부하기 — 스키마
-- 원칙
--  * 모든 쓰기는 서버 함수(RPC)로만. 테이블 직접 쓰기 정책은 두지 않는다.
--  * 개인 기록은 본인만 읽기. 반 친구에게는 member_status(이름·상태·시간·공개한 과목)만 보인다.
--  * 시간은 서버 시각으로 시작·종료를 저장하고, 화면은 그 값으로 계산한다.

-- ───────── 시간 도우미 (한국 시간 고정 +9h, 서머타임 없음)
create or replace function public.kst_day(ts timestamptz) returns date
language sql immutable as $$ select ((ts at time zone 'UTC') + interval '9 hours')::date $$;

create or replace function public.kst_midnight(d date) returns timestamptz
language sql immutable as $$ select (d::timestamp - interval '9 hours') at time zone 'UTC' $$;

create or replace function public.kst_hour(ts timestamptz) returns int
language sql immutable as $$ select extract(hour from (ts at time zone 'UTC') + interval '9 hours')::int $$;

-- ───────── 프로필
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  share_subject boolean not null default true,      -- 우리 반에 현재 과목 공개
  show_in_ranking boolean not null default false,   -- 랭킹 참여 (선택)
  daily_goal_min int check (daily_goal_min between 0 and 1440),
  weekly_goal_min int check (weekly_goal_min between 0 and 10080),
  notify jsonb not null default '{}'::jsonb,         -- 알림 종류별 켜기/끄기
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────── 과목 (삭제 대신 보관: 기록 보존)
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null default '#7da2f0' check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon text check (char_length(icon) <= 8),
  sort int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subjects_active_name on public.subjects(user_id, lower(name)) where not archived;

-- ───────── 공동 공부방
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null
);
insert into public.rooms(slug, name) values ('class-2-3', '2-3반 함께 공부하기');

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user on public.room_members(user_id);

-- ───────── 시험·수행평가 (room_id 가 있으면 공동 공부방 일정)
create table public.exams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  exam_date date not null,
  kind text not null default 'exam' check (kind in ('exam', 'performance')),
  subject_id uuid references public.subjects(id) on delete set null,
  notify boolean not null default false,
  created_at timestamptz not null default now()
);

-- ───────── 퀘스트
create table public.quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  diff smallint not null default 2 check (diff between 1 and 3),
  subject_id uuid references public.subjects(id) on delete set null,
  exam_id uuid references public.exams(id) on delete set null,
  plan_date date not null,
  due_date date,
  notify_due boolean not null default false,
  color_idx smallint not null default 0,
  done boolean not null default false,
  done_at timestamptz,
  deleted_at timestamptz,
  legacy_id text,
  created_at timestamptz not null default now(),
  unique (user_id, legacy_id)
);
create index quests_user_plan on public.quests(user_id, plan_date);

-- ───────── 타이머: 세션 + 구간
create table public.timer_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  last_event_at timestamptz not null,
  end_reason text
);
-- 같은 계정의 활성 타이머는 하나만
create unique index one_active_session on public.timer_sessions(user_id) where ended_at is null;

create table public.segments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.timer_sessions(id) on delete cascade,
  kind text not null check (kind in ('study', 'break')),
  subject_id uuid references public.subjects(id) on delete set null,
  quest_id uuid references public.quests(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  legacy_key text,
  check (ended_at is null or ended_at >= started_at),
  unique (user_id, legacy_key)
);
create index segments_user_time on public.segments(user_id, started_at);
create index segments_quest on public.segments(quest_id) where quest_id is not null;
-- 한 세션의 열린 구간은 하나만
create unique index one_open_segment on public.segments(session_id) where ended_at is null;

-- 재시도·연속 클릭 중복 방지: 같은 op_id 는 한 번만 처리
create table public.timer_ops (
  op_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- ───────── 보상 (XP 원장)
create table public.quest_rewards (
  quest_id uuid primary key references public.quests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lucky boolean not null,          -- 처음 완료할 때 한 번만 판정, 이후 재사용
  minutes int not null,
  xp int not null,
  active boolean not null,         -- 완료 취소 시 false (XP 회수)
  early boolean not null default false,
  late boolean not null default false,
  long boolean not null default false,
  max_seg_min int not null default 0,
  first_done_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quest_rewards_user on public.quest_rewards(user_id);

create table public.xp_bonuses (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('perfect')),
  ref text not null,               -- perfect: 날짜
  xp int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, ref)
);

create table public.legacy_baseline (
  user_id uuid primary key references auth.users(id) on delete cascade,
  totals jsonb not null,
  import_count int not null default 1,
  imported_at timestamptz not null default now()
);

-- ───────── 업적
create table public.badge_defs (
  id text primary key,
  metric text not null,
  threshold numeric not null
);
create table public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_id text not null references public.badge_defs(id),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

-- ───────── 사용자가 바꾼 대학 로고 (모든 기기에서 동일)
create table public.user_logos (
  user_id uuid not null references auth.users(id) on delete cascade,
  univ_idx smallint not null check (univ_idx between 0 and 35),
  data_url text not null check (data_url like 'data:image/%' and length(data_url) < 600000),
  updated_at timestamptz not null default now(),
  primary key (user_id, univ_idx)
);

-- ───────── 다기기 동기화 신호: 내 데이터가 바뀌면 rev 증가 → 다른 기기가 다시 불러옴
create table public.user_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rev bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ───────── 우리 반에 보이는 상태 (공개용 요약만)
create table public.member_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  state text not null default 'idle' check (state in ('study', 'break', 'idle')),
  session_started_at timestamptz,
  focus_since timestamptz,         -- 이번 집중(휴식 없이 이어진 공부) 시작
  open_since timestamptz,          -- 현재 공부 구간 시작 (오늘 누적 계산용)
  break_since timestamptz,
  today_date date,
  today_closed_sec int not null default 0, -- today_date 의 닫힌 공부 구간 합
  subject_label text,              -- 공개 선택 시에만
  subject_color text,
  updated_at timestamptz not null default now()
);
-- 앱 마지막 확인 (접속 상태와 타이머 상태는 별개). 자주 바뀌므로 실시간 전송 대상에서 분리해 메시지 사용량을 줄인다.
create table public.member_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);

-- ───────── 공동 학습
create table public.cheers (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  preset smallint not null check (preset between 1 and 8),
  created_at timestamptz not null default now()
);
create index cheers_to on public.cheers(to_user, created_at desc);

create table public.group_studies (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  host_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 40),
  starts_at timestamptz not null,
  duration_min int not null check (duration_min between 10 and 600),
  cancelled boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.group_participants (
  group_id uuid not null references public.group_studies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.room_goals (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 40),
  target_min int not null check (target_min between 1 and 1000000),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  created_at timestamptz not null default now()
);

-- ───────── 행 수준 보안: 읽기만 정책으로 허용, 쓰기는 모두 서버 함수 경유
alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.exams enable row level security;
alter table public.quests enable row level security;
alter table public.timer_sessions enable row level security;
alter table public.segments enable row level security;
alter table public.timer_ops enable row level security;
alter table public.quest_rewards enable row level security;
alter table public.xp_bonuses enable row level security;
alter table public.legacy_baseline enable row level security;
alter table public.badge_defs enable row level security;
alter table public.user_badges enable row level security;
alter table public.user_logos enable row level security;
alter table public.user_heads enable row level security;
alter table public.member_status enable row level security;
alter table public.member_presence enable row level security;
alter table public.cheers enable row level security;
alter table public.group_studies enable row level security;
alter table public.group_participants enable row level security;
alter table public.room_goals enable row level security;

-- 같은 방 구성원인지 (정책 안에서 재귀를 피하려고 security definer)
create or replace function public.shares_room(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from room_members a join room_members b on a.room_id = b.room_id
    where a.user_id = auth.uid() and b.user_id = other)
$$;
create or replace function public.is_member(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_id = r and user_id = auth.uid())
$$;

create policy own_read on public.profiles for select to authenticated using (id = auth.uid());
create policy own_read on public.subjects for select to authenticated using (user_id = auth.uid());
create policy own_read on public.quests for select to authenticated using (user_id = auth.uid());
create policy own_read on public.timer_sessions for select to authenticated using (user_id = auth.uid());
create policy own_read on public.segments for select to authenticated using (user_id = auth.uid());
create policy own_read on public.quest_rewards for select to authenticated using (user_id = auth.uid());
create policy own_read on public.xp_bonuses for select to authenticated using (user_id = auth.uid());
create policy own_read on public.legacy_baseline for select to authenticated using (user_id = auth.uid());
create policy own_read on public.user_badges for select to authenticated using (user_id = auth.uid());
create policy own_read on public.user_logos for select to authenticated using (user_id = auth.uid());
create policy own_read on public.user_heads for select to authenticated using (user_id = auth.uid());
create policy all_read on public.badge_defs for select to authenticated using (true);
create policy all_read on public.rooms for select to authenticated using (true);
create policy member_read on public.room_members for select to authenticated using (user_id = auth.uid() or public.shares_room(user_id));
create policy visible on public.exams for select to authenticated using (owner_id = auth.uid() or (room_id is not null and public.is_member(room_id)));
create policy visible on public.member_status for select to authenticated using (user_id = auth.uid() or public.shares_room(user_id));
create policy visible on public.member_presence for select to authenticated using (user_id = auth.uid() or public.shares_room(user_id));
create policy visible on public.cheers for select to authenticated using (to_user = auth.uid() or from_user = auth.uid());
create policy visible on public.group_studies for select to authenticated using (public.is_member(room_id));
create policy visible on public.group_participants for select to authenticated using (exists (select 1 from public.group_studies g where g.id = group_id and public.is_member(g.room_id)));
create policy visible on public.room_goals for select to authenticated using (public.is_member(room_id));
-- timer_ops: 정책 없음 (서버 함수만 접근)
`,j=`-- 자동 생성: npm run gen:badges (src/shared/badges.ts 원본, 74개)
insert into public.badge_defs(id, metric, threshold) values
  ('first', 'total', 1),
  ('q10', 'total', 10),
  ('q50', 'total', 50),
  ('q100', 'total', 100),
  ('q300', 'total', 300),
  ('q500', 'total', 500),
  ('q1000', 'total', 1000),
  ('hour', 'max_day_min', 60),
  ('h3', 'max_day_min', 180),
  ('h5', 'max_day_min', 300),
  ('h6', 'max_day_min', 360),
  ('h8', 'max_day_min', 480),
  ('h10', 'max_day_min', 600),
  ('long', 'long', 1),
  ('f180', 'max_focus_min', 180),
  ('f240', 'max_focus_min', 240),
  ('tm10', 'total_min', 600),
  ('tm50', 'total_min', 3000),
  ('tm100', 'total_min', 6000),
  ('tm200', 'total_min', 12000),
  ('tm500', 'total_min', 30000),
  ('tm1000', 'total_min', 60000),
  ('tm2000', 'total_min', 120000),
  ('tm3000', 'total_min', 180000),
  ('tm5000', 'total_min', 300000),
  ('tm6000', 'total_min', 360000),
  ('w40', 'last7_min', 2400),
  ('w56', 'last7_min', 3360),
  ('m200', 'last30_min', 12000),
  ('m240', 'last30_min', 14400),
  ('s3', 'best_streak', 3),
  ('s7', 'best_streak', 7),
  ('s14', 'best_streak', 14),
  ('s30', 'best_streak', 30),
  ('s60', 'best_streak', 60),
  ('s100', 'best_streak', 100),
  ('s180', 'best_streak', 180),
  ('s365', 'best_streak', 365),
  ('s500', 'best_streak', 500),
  ('s730', 'best_streak', 730),
  ('sd30', 'study_days', 30),
  ('sd100', 'study_days', 100),
  ('sd200', 'study_days', 200),
  ('sd365', 'study_days', 365),
  ('sd730', 'study_days', 730),
  ('perfect', 'perfects', 1),
  ('perfect5', 'perfects', 5),
  ('perfect10', 'perfects', 10),
  ('perfect30', 'perfects', 30),
  ('perfect100', 'perfects', 100),
  ('perfect200', 'perfects', 200),
  ('hard', 'hard', 1),
  ('hard10', 'hard', 10),
  ('hard50', 'hard', 50),
  ('hard100', 'hard', 100),
  ('hard300', 'hard', 300),
  ('lucky', 'lucky', 1),
  ('lucky10', 'lucky', 10),
  ('lucky50', 'lucky', 50),
  ('early', 'early', 1),
  ('late', 'late', 1),
  ('early30', 'early', 30),
  ('late30', 'late', 30),
  ('rest1', 'rest_total_min', 1),
  ('restbal', 'balanced_days', 1),
  ('rest100', 'rest_total_min', 6000),
  ('lv5', 'level', 5),
  ('lv10', 'level', 10),
  ('lv15', 'level', 15),
  ('lv20', 'level', 20),
  ('lv25', 'level', 25),
  ('lv30', 'level', 30),
  ('sky', 'level', 34),
  ('top', 'level', 36)
on conflict (id) do update set metric = excluded.metric, threshold = excluded.threshold;
`,q=`-- 서버 함수 (RPC). 모두 auth.uid() 로 본인 확인 후 동작한다.

create or replace function public._uid() returns uuid
language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public._bump(u uuid) returns void
language sql security definer set search_path = public as $$
  insert into user_heads(user_id, rev, updated_at) values (u, 1, now())
  on conflict (user_id) do update set rev = user_heads.rev + 1, updated_at = now();
  -- 조작이 서버에 도착했다는 것 자체가 앱 연결 확인
  insert into member_presence(user_id, last_seen) values (u, now()) on conflict (user_id) do update set last_seen = now();
$$;

create or replace function public.level_from_xp(xp bigint) returns int
language plpgsql immutable as $$
declare l int := 1; r bigint := xp;
begin
  while l < 36 and r >= 600 + 503 * (l - 1) loop
    r := r - (600 + 503 * (l - 1)); l := l + 1;
  end loop;
  return l;
end $$;

-- 구간을 한국 시간 날짜별로 나눈 초 (진행 중 구간은 지금까지)
create or replace function public._seg_days(u uuid, from_day date default null, to_day date default null)
returns table(day date, kind text, subject_id uuid, sec numeric)
language sql stable security definer set search_path = public as $$
  with s as (
    select g.kind, g.subject_id, g.started_at a, coalesce(g.ended_at, now()) b
    from segments g
    where g.user_id = u
      and (from_day is null or coalesce(g.ended_at, now()) > kst_midnight(from_day))
      and (to_day is null or g.started_at < kst_midnight(to_day) + interval '1 day')
  )
  select dd.day, s.kind, s.subject_id,
         extract(epoch from (least(s.b, kst_midnight(dd.day) + interval '1 day') - greatest(s.a, kst_midnight(dd.day))))::numeric
  from s
  cross join lateral (
    select gs::date as day
    from generate_series(kst_day(s.a)::timestamp, kst_day(greatest(s.a, s.b - interval '1 microsecond'))::timestamp, interval '1 day') gs
  ) dd
  where s.b > s.a
    and (from_day is null or dd.day >= from_day)
    and (to_day is null or dd.day <= to_day)
$$;

-- ───────── 우리 반에 보이는 상태 갱신
create or replace function public._refresh_status(u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p profiles; ses timer_sessions; openseg segments; sub subjects;
  today date := kst_day(now());
  closed int; fsince timestamptz; prev record;
begin
  select * into p from profiles where id = u;
  if not found then return; end if;
  select * into ses from timer_sessions where user_id = u and ended_at is null;
  if found then
    select * into openseg from segments where session_id = ses.id and ended_at is null;
  end if;
  -- 오늘 닫힌 공부 구간 합
  select coalesce(sum(extract(epoch from (least(g.ended_at, kst_midnight(today) + interval '1 day') - greatest(g.started_at, kst_midnight(today))))), 0)::int
    into closed
    from segments g
    where g.user_id = u and g.kind = 'study' and g.ended_at is not null
      and g.ended_at > kst_midnight(today) and g.started_at < kst_midnight(today) + interval '1 day';
  -- 이번 집중 시작: 현재 공부 구간에서 휴식 없이 이어진 구간을 거슬러 올라감
  fsince := null;
  if openseg.id is not null and openseg.kind = 'study' then
    fsince := openseg.started_at;
    for prev in select kind, started_at, ended_at from segments
                where session_id = ses.id and ended_at is not null order by started_at desc loop
      exit when prev.kind <> 'study' or abs(extract(epoch from (fsince - prev.ended_at))) > 1;
      fsince := prev.started_at;
    end loop;
    select * into sub from subjects where id = openseg.subject_id;
  end if;
  insert into member_status(user_id, display_name, state, session_started_at, focus_since, open_since, break_since,
                            today_date, today_closed_sec, subject_label, subject_color, updated_at)
  values (u, p.display_name,
          case when openseg.id is null then 'idle' else openseg.kind end,
          ses.started_at,
          fsince,
          case when openseg.kind = 'study' then openseg.started_at end,
          case when openseg.kind = 'break' then openseg.started_at end,
          today, closed,
          case when p.share_subject and openseg.kind = 'study' then sub.name end,
          case when p.share_subject and openseg.kind = 'study' then sub.color end,
          now())
  on conflict (user_id) do update set
    display_name = excluded.display_name, state = excluded.state, session_started_at = excluded.session_started_at,
    focus_since = excluded.focus_since, open_since = excluded.open_since, break_since = excluded.break_since,
    today_date = excluded.today_date, today_closed_sec = excluded.today_closed_sec,
    subject_label = excluded.subject_label, subject_color = excluded.subject_color, updated_at = now();
end $$;

-- ───────── 프로필·과목
create or replace function public.save_profile(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); is_new boolean;
begin
  is_new := not exists (select 1 from profiles where id = u);
  if is_new and coalesce(trim(p->>'display_name'), '') = '' then raise exception 'display_name_required'; end if;
  if is_new then
    insert into profiles(id, display_name) values (u, trim(p->>'display_name')) on conflict (id) do nothing;
  end if;
  update profiles set
    display_name = coalesce(nullif(trim(p->>'display_name'), ''), display_name),
    share_subject = coalesce((p->>'share_subject')::boolean, share_subject),
    show_in_ranking = coalesce((p->>'show_in_ranking')::boolean, show_in_ranking),
    daily_goal_min = case when p ? 'daily_goal_min' then nullif(p->>'daily_goal_min', '')::int else daily_goal_min end,
    weekly_goal_min = case when p ? 'weekly_goal_min' then nullif(p->>'weekly_goal_min', '')::int else weekly_goal_min end,
    notify = case when p ? 'notify' then p->'notify' else notify end,
    updated_at = now()
  where id = u;
  if is_new then
    insert into subjects(user_id, name, color, sort) values
      (u, '국어', '#e0b25a', 0), (u, '수학', '#7da2f0', 1), (u, '영어', '#5fb38a', 2),
      (u, '한국사', '#c97a9a', 3), (u, '탐구', '#8e7de0', 4);
  end if;
  perform _refresh_status(u);
  perform _bump(u);
  return (select to_jsonb(x) from profiles x where id = u);
end $$;

create or replace function public.subject_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); r subjects;
begin
  if p->>'id' is null then
    insert into subjects(user_id, name, color, icon, sort)
    values (u, trim(p->>'name'), coalesce(p->>'color', '#7da2f0'), nullif(p->>'icon', ''),
            coalesce((select max(sort) + 1 from subjects where user_id = u), 0))
    returning * into r;
  else
    update subjects set name = coalesce(nullif(trim(p->>'name'), ''), name), color = coalesce(p->>'color', color),
      icon = case when p ? 'icon' then nullif(p->>'icon', '') else icon end, updated_at = now()
    where id = (p->>'id')::uuid and user_id = u returning * into r;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform _refresh_status(u); perform _bump(u);
  return to_jsonb(r);
exception when unique_violation then raise exception 'subject_name_taken';
end $$;

create or replace function public.subject_reorder(ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  update subjects s set sort = o.ord - 1, updated_at = now()
  from unnest(ids) with ordinality o(id, ord) where s.id = o.id and s.user_id = u;
  perform _bump(u);
end $$;

-- 보관: 과거 기록은 그대로 남고 선택 목록에서만 숨김
create or replace function public.subject_archive(sid uuid, archived boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if archived and exists (select 1 from timer_sessions t join segments g on g.session_id = t.id
                          where t.user_id = u and t.ended_at is null and g.ended_at is null and g.subject_id = sid) then
    raise exception 'subject_in_use';
  end if;
  update subjects set archived = subject_archive.archived, updated_at = now() where id = sid and user_id = u;
  perform _bump(u);
exception when unique_violation then raise exception 'subject_name_taken';
end $$;

-- 기록이 하나도 없는 과목만 완전 삭제 (실수로 만든 과목 정리용)
create or replace function public.subject_delete(sid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if exists (select 1 from segments where user_id = u and subject_id = sid)
     or exists (select 1 from quests where user_id = u and subject_id = sid) then
    raise exception 'subject_has_records';
  end if;
  delete from subjects where id = sid and user_id = u;
  perform _bump(u);
end $$;

-- ───────── 타이머
create or replace function public._timer_state(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'server_now', now(),
    'session', (select to_jsonb(t) from timer_sessions t where user_id = u and ended_at is null),
    'segments', coalesce((select jsonb_agg(to_jsonb(g) order by g.started_at)
                          from segments g join timer_sessions t on t.id = g.session_id
                          where t.user_id = u and t.ended_at is null), '[]'::jsonb))
$$;

create or replace function public.timer_state() returns jsonb
language sql stable security definer set search_path = public as $$ select _timer_state(_uid()) $$;

-- action: start | break | resume | switch | end
-- client_at: 오프라인에서 누른 시각(서버 시각으로 환산한 값). 서버 현재 시각보다 미래면 현재로 자른다.
-- expect_session: 화면이 알고 있는 세션. 다른 기기에서 이미 끝난 세션이면 적용하지 않는다.
create or replace function public.timer_act(op_id uuid, action text, subject_id uuid default null, quest_id uuid default null,
                                            client_at timestamptz default null, expect_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := _uid(); done jsonb; ses timer_sessions; seg segments; t timestamptz; res jsonb;
  nsub uuid := subject_id; nquest uuid := quest_id; reason text := null; changed boolean := true;
begin
  select result into done from timer_ops where timer_ops.op_id = timer_act.op_id and user_id = u;
  if found then return done || jsonb_build_object('state', _timer_state(u), 'replayed', true); end if;

  if action not in ('start', 'break', 'resume', 'switch', 'end') then raise exception 'bad_action'; end if;
  if nsub is not null and not exists (select 1 from subjects s where s.id = nsub and s.user_id = u) then raise exception 'bad_subject'; end if;
  if nquest is not null and not exists (select 1 from quests q where q.id = nquest and q.user_id = u and q.deleted_at is null and not q.done) then
    raise exception 'bad_quest';
  end if;

  t := least(coalesce(client_at, now()), now());
  select * into ses from timer_sessions where user_id = u and ended_at is null for update;
  if found then
    select * into seg from segments where session_id = ses.id and ended_at is null for update;
    -- 다른 기기의 더 최근 기록을 오래된 조작으로 덮어쓰지 않는다
    if client_at is not null and client_at < ses.last_event_at - interval '2 seconds' then reason := 'outdated'; end if;
    if expect_session is not null and expect_session <> ses.id then reason := 'other_session'; end if;
    t := greatest(t, ses.last_event_at);
  elsif expect_session is not null and action <> 'start' then
    reason := 'session_ended';
  end if;

  if reason is null then
    if action = 'start' then
      if ses.id is not null then
        changed := false; reason := 'already_active';
      else
        -- 직전 세션 종료 시각보다 앞서지 않게, 오프라인 시작이라도 12시간 이전으로는 잡지 않음
        t := greatest(t, now() - interval '12 hours', coalesce((select max(ended_at) from timer_sessions where user_id = u), t));
        begin
          insert into timer_sessions(user_id, started_at, last_event_at) values (u, t, t) returning * into ses;
        exception when unique_violation then
          changed := false; reason := 'already_active';
        end;
        if changed then
          insert into segments(user_id, session_id, kind, subject_id, quest_id, started_at) values (u, ses.id, 'study', nsub, nquest, t);
        end if;
      end if;
    elsif ses.id is null then
      changed := false; reason := 'no_session';
    elsif action = 'break' then
      if seg.kind = 'study' then
        update segments set ended_at = t where id = seg.id;
        insert into segments(user_id, session_id, kind, started_at) values (u, ses.id, 'break', t);
      else changed := false; reason := 'already_break'; end if;
    elsif action in ('resume', 'switch') then
      if seg.kind = 'break' or (action = 'switch' and seg.kind = 'study') then
        if nsub is null and nquest is null then
          select g.subject_id, g.quest_id into nsub, nquest from segments g
          where g.session_id = ses.id and g.kind = 'study' order by g.started_at desc limit 1;
          if nquest is not null and not exists (select 1 from quests q where q.id = nquest and not q.done and q.deleted_at is null) then nquest := null; end if;
        end if;
        if action = 'switch' and seg.kind = 'study' and seg.subject_id is not distinct from nsub and seg.quest_id is not distinct from nquest then
          changed := false; reason := 'same_subject';
        else
          update segments set ended_at = t where id = seg.id;
          insert into segments(user_id, session_id, kind, subject_id, quest_id, started_at) values (u, ses.id, 'study', nsub, nquest, t);
        end if;
      else changed := false; reason := 'not_on_break'; end if;
    elsif action = 'end' then
      update segments set ended_at = t where session_id = ses.id and ended_at is null;
      update timer_sessions set ended_at = t, end_reason = case when client_at is not null then 'chosen_time' else 'user' end where id = ses.id;
    end if;
    if changed and ses.id is not null then
      update timer_sessions set last_event_at = t where id = ses.id;
    end if;
  end if;

  if changed and reason is null then
    perform _refresh_status(u);
    perform _bump(u);
  end if;
  res := jsonb_build_object('ok', reason is null or reason in ('already_active', 'already_break', 'same_subject'), 'changed', changed and reason is null, 'reason', reason);
  insert into timer_ops(op_id, user_id, result) values (timer_act.op_id, u, res) on conflict do nothing;
  return res || jsonb_build_object('state', _timer_state(u));
end $$;

-- 앱이 열려 있는 동안 주기적으로 호출 (접속 확인). 타이머 상태와는 별개.
create or replace function public.heartbeat() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  insert into member_presence(user_id, last_seen) values (u, now())
  on conflict (user_id) do update set last_seen = now() where member_presence.last_seen < now() - interval '20 seconds';
  if not exists (select 1 from member_status where user_id = u) then perform _refresh_status(u); end if;
  return now();
end $$;

-- ───────── 퀘스트
create or replace function public.quest_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); r quests;
begin
  if (p->>'subject_id') is not null and not exists (select 1 from subjects where id = (p->>'subject_id')::uuid and user_id = u) then raise exception 'bad_subject'; end if;
  if (p->>'exam_id') is not null and not exists (select 1 from exams e where e.id = (p->>'exam_id')::uuid and (e.owner_id = u or (e.room_id is not null and is_member(e.room_id)))) then raise exception 'bad_exam'; end if;
  if p->>'id' is null then
    insert into quests(user_id, name, diff, subject_id, exam_id, plan_date, due_date, notify_due, color_idx)
    values (u, trim(p->>'name'), coalesce((p->>'diff')::smallint, 2), (p->>'subject_id')::uuid, (p->>'exam_id')::uuid,
            coalesce((p->>'plan_date')::date, kst_day(now())), (p->>'due_date')::date, coalesce((p->>'notify_due')::boolean, false),
            coalesce((p->>'color_idx')::smallint, (select count(*) % 8 from quests where user_id = u and plan_date = coalesce((p->>'plan_date')::date, kst_day(now())))))
    returning * into r;
  else
    select * into r from quests where id = (p->>'id')::uuid and user_id = u and deleted_at is null for update;
    if not found then raise exception 'not_found'; end if;
    -- 완료된 퀘스트의 난이도는 바꾸지 않는다 (보상이 이미 계산됨)
    update quests set
      name = coalesce(nullif(trim(p->>'name'), ''), name),
      diff = case when done then diff else coalesce((p->>'diff')::smallint, diff) end,
      subject_id = case when p ? 'subject_id' then (p->>'subject_id')::uuid else subject_id end,
      exam_id = case when p ? 'exam_id' then (p->>'exam_id')::uuid else exam_id end,
      plan_date = coalesce((p->>'plan_date')::date, plan_date),
      due_date = case when p ? 'due_date' then (p->>'due_date')::date else due_date end,
      notify_due = coalesce((p->>'notify_due')::boolean, notify_due)
    where id = r.id returning * into r;
  end if;
  perform _bump(u);
  return to_jsonb(r);
end $$;

create or replace function public.quest_delete(qid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); q quests;
begin
  select * into q from quests where id = qid and user_id = u for update;
  if not found then raise exception 'not_found'; end if;
  if q.done then raise exception 'quest_done'; end if; -- 원본도 완료한 퀘스트는 삭제 버튼이 없음
  update quests set deleted_at = now() where id = qid;
  -- 진행 중 구간이 이 퀘스트에 연결돼 있으면 연결만 끊는다 (공부 시간은 유지)
  update segments set quest_id = null where quest_id = qid and ended_at is null;
  perform _bump(u);
end $$;

create or replace function public._quest_minutes(qid uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(floor(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))) / 60), 0)::int
  from segments where quest_id = qid and kind = 'study'
$$;

-- 완료: XP = 퀘스트에 기록된 분 × 난이도 배율 (15% 추가 보상 ×2), 오늘 계획을 모두 끝내면 +50
create or replace function public.quest_complete(qid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := _uid(); q quests; rw quest_rewards; m int; lucky boolean; g int; mult numeric;
  xp_before bigint; xp_after bigint; perfect boolean := false; today date := kst_day(now());
  openseg segments; nb jsonb; first_time boolean;
begin
  select * into q from quests where id = qid and user_id = u and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if q.done then return jsonb_build_object('already', true); end if;
  xp_before := (select coalesce(sum(xp), 0) from quest_rewards where user_id = u and active) + (select coalesce(sum(xp), 0) from xp_bonuses where user_id = u);

  -- 이 퀘스트로 측정 중이면 퀘스트 연결만 끊고 공부는 계속 (원본은 이 퀘스트 측정을 멈춤)
  select g2.* into openseg from segments g2 join timer_sessions t on t.id = g2.session_id
   where t.user_id = u and t.ended_at is null and g2.ended_at is null and g2.quest_id = qid;
  if found then
    update segments set ended_at = now() where id = openseg.id;
    insert into segments(user_id, session_id, kind, subject_id, quest_id, started_at) values (u, openseg.session_id, 'study', openseg.subject_id, null, now());
    update timer_sessions set last_event_at = now() where id = openseg.session_id;
  end if;

  m := _quest_minutes(qid);
  if m < 1 then raise exception 'need_minutes'; end if;
  mult := case q.diff when 1 then 1 when 2 then 1.5 else 2 end;
  select * into rw from quest_rewards where quest_id = qid;
  first_time := not found;
  lucky := case when first_time then random() < 0.15 else rw.lucky end; -- 추가 보상은 처음 한 번만 판정
  g := round(m * mult * case when lucky then 2 else 1 end);
  insert into quest_rewards(quest_id, user_id, lucky, minutes, xp, active, early, late, long, max_seg_min)
  select qid, u, lucky, m, g, true,
         bool_or(kst_hour(started_at) < 6), bool_or(kst_hour(coalesce(ended_at, now())) >= 22), m >= 120,
         coalesce(max(floor(extract(epoch from (coalesce(ended_at, now()) - started_at)) / 60)), 0)
    from segments where quest_id = qid and kind = 'study'
  on conflict (quest_id) do update set minutes = excluded.minutes, xp = excluded.xp, active = true,
    early = excluded.early, late = excluded.late, long = excluded.long, max_seg_min = excluded.max_seg_min, updated_at = now();
  update quests set done = true, done_at = now() where id = qid;

  if q.plan_date = today and not exists (select 1 from quests where user_id = u and plan_date = today and deleted_at is null and not done) then
    insert into xp_bonuses(user_id, kind, ref, xp) values (u, 'perfect', today::text, 50) on conflict do nothing;
    perfect := found;
  end if;
  xp_after := (select coalesce(sum(xp), 0) from quest_rewards where user_id = u and active) + (select coalesce(sum(xp), 0) from xp_bonuses where user_id = u);
  nb := _evaluate_badges(u);
  perform _refresh_status(u); perform _bump(u);
  return jsonb_build_object('minutes', m, 'xp', g, 'lucky', lucky, 'perfect', perfect, 'xp_before', xp_before, 'xp_after', xp_after,
                            'level_before', level_from_xp(xp_before), 'level_after', level_from_xp(xp_after), 'new_badges', nb);
end $$;

-- 완료 취소: XP 회수. 다시 완료하면 처음 판정한 추가 보상 결과를 그대로 쓰므로 중복 획득 없음.
create or replace function public.quest_uncomplete(qid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  update quests set done = false, done_at = null where id = qid and user_id = u and done and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  update quest_rewards set active = false, updated_at = now() where quest_id = qid;
  perform _bump(u);
  return jsonb_build_object('ok', true);
end $$;

-- ───────── 진행 지표·업적 (badge_defs 의 metric 과 같은 이름)
create or replace function public._metrics(u uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  b jsonb := coalesce((select totals from legacy_baseline where user_id = u), '{}'::jsonb);
  today date := kst_day(now()); r jsonb; v_xp bigint; best int; cur int; focus int;
begin
  v_xp := (select coalesce(sum(r1.xp), 0) from quest_rewards r1 where r1.user_id = u and r1.active) + (select coalesce(sum(b1.xp), 0) from xp_bonuses b1 where b1.user_id = u);
  -- 연속 학습: 퀘스트를 완료한 날 (이전 기록은 원래 날짜)
  with d as (
    select distinct case when legacy_id is not null then plan_date else kst_day(done_at) end as day
    from quests where user_id = u and done and deleted_at is null
  ), isl as (select day, day - (row_number() over (order by day))::int as grp from d),
  runs as (select min(day) s, max(day) e, count(*)::int n from isl group by grp)
  select coalesce(max(n), 0), coalesce(max(n) filter (where e >= today - 1), 0) into best, cur from runs;
  -- 이번 집중(휴식 없이 이어진 공부) 최대 분
  with s as (
    select kind, started_at, coalesce(ended_at, now()) e,
           lag(kind) over w pk, lag(coalesce(ended_at, now())) over w pe
    from segments where user_id = u window w as (order by started_at)
  ), f as (
    select started_at, e, sum(case when pk is distinct from 'study' or abs(extract(epoch from (started_at - pe))) > 1 then 1 else 0 end) over (order by started_at) grp
    from s where kind = 'study'
  )
  select coalesce(max(floor(extract(epoch from (mx - mn)) / 60)), 0)::int into focus
  from (select min(started_at) mn, max(e) mx from f group by grp) z;

  with days as (
    select day, sum(sec) filter (where kind = 'study') / 60 st, sum(sec) filter (where kind = 'break') / 60 rs
    from _seg_days(u) group by day
  )
  select jsonb_build_object(
    'xp', v_xp,
    'level', level_from_xp(v_xp),
    'total', greatest((select count(*) from quests where user_id = u and done and deleted_at is null), coalesce((b->>'total')::int, 0)),
    'hard', greatest((select count(*) from quests where user_id = u and done and deleted_at is null and diff = 3), coalesce((b->>'hard')::int, 0)),
    'lucky', greatest((select count(*) from quest_rewards where user_id = u and active and lucky), coalesce((b->>'lucky')::int, 0)),
    'early', greatest((select count(*) from quest_rewards where user_id = u and active and early), coalesce((b->>'early')::int, 0)),
    'late', greatest((select count(*) from quest_rewards where user_id = u and active and late), coalesce((b->>'late')::int, 0)),
    'long', greatest((select count(*) from quest_rewards where user_id = u and active and long), coalesce((b->>'long')::int, 0)),
    'perfects', greatest((select count(*) from xp_bonuses where user_id = u and kind = 'perfect'), coalesce((b->>'perfects')::int, 0)),
    'max_focus_min', greatest(focus, coalesce((b->>'maxs')::int, 0)),
    'best_streak', greatest(best, coalesce((b->>'best')::int, 0)),
    'current_streak', cur,
    'total_min', coalesce((select floor(sum(st)) from days), 0),
    'max_day_min', coalesce((select floor(max(st)) from days), 0),
    'last7_min', coalesce((select floor(sum(st)) from days where day >= today - 6), 0),
    'last30_min', coalesce((select floor(sum(st)) from days where day >= today - 29), 0),
    'study_days', (select count(*) from days where st >= 1),
    'rest_total_min', coalesce((select floor(sum(rs)) from days), 0),
    'balanced_days', (select count(*) from days where st >= 240 and rs >= 30)
  ) into r;
  return r;
end $$;

create or replace function public._evaluate_badges(u uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m jsonb := _metrics(u); nb jsonb;
begin
  with ins as (
    insert into user_badges(user_id, badge_id)
    select u, d.id from badge_defs d where coalesce((m->>d.metric)::numeric, 0) >= d.threshold
    on conflict do nothing returning badge_id
  ) select coalesce(jsonb_agg(badge_id), '[]'::jsonb) into nb from ins;
  return nb;
end $$;

-- 내 진행: XP, 지표, 해제한 업적 (호출 시 새로 달성한 업적도 반영)
create or replace function public.my_progress() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); nb jsonb;
begin
  nb := _evaluate_badges(u);
  return jsonb_build_object('metrics', _metrics(u), 'new_badges', nb,
    'badges', coalesce((select jsonb_object_agg(badge_id, unlocked_at) from user_badges where user_id = u), '{}'::jsonb));
end $$;

-- ───────── 처음 불러오기 (모든 기기 공통)
create or replace function public.app_bootstrap() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); today date := kst_day(now());
begin
  return jsonb_build_object(
    'server_now', now(),
    'profile', (select to_jsonb(p) from profiles p where id = u),
    'rev', coalesce((select rev from user_heads where user_id = u), 0),
    'subjects', coalesce((select jsonb_agg(to_jsonb(s) order by s.archived, s.sort, s.created_at) from subjects s where user_id = u), '[]'::jsonb),
    'timer', _timer_state(u),
    'quests', coalesce((select jsonb_agg(to_jsonb(q) || jsonb_build_object('minutes', _quest_minutes(q.id),
                          'reward', (select to_jsonb(r) - 'user_id' from quest_rewards r where r.quest_id = q.id)) order by q.plan_date, q.created_at)
                        from quests q where q.user_id = u and q.deleted_at is null
                          and (q.plan_date >= today - 60 or not q.done or q.due_date >= today - 7)), '[]'::jsonb),
    'exams', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('mine', e.owner_id = u) order by e.exam_date)
                       from exams e where e.owner_id = u or (e.room_id is not null and is_member(e.room_id))), '[]'::jsonb),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name,
                         'joined', exists (select 1 from room_members m where m.room_id = r.id and m.user_id = u))) from rooms r), '[]'::jsonb)
  );
end $$;

-- 기록 화면: 범위 안의 구간과 퀘스트
create or replace function public.my_records(from_day date, to_day date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'server_now', now(),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'subject_id', subject_id, 'quest_id', quest_id, 'session_id', session_id,
                            'started_at', started_at, 'ended_at', ended_at) order by started_at)
                          from segments where user_id = _uid()
                            and coalesce(ended_at, now()) > kst_midnight(from_day) and started_at < kst_midnight(to_day) + interval '1 day'), '[]'::jsonb),
    'quests', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'subject_id', subject_id, 'plan_date', plan_date,
                          'done', done, 'done_at', done_at, 'deleted', deleted_at is not null))
                        from quests where user_id = _uid() and plan_date between from_day and to_day), '[]'::jsonb),
    'subject_totals', coalesce((select jsonb_object_agg(coalesce(subject_id::text, ''), m) from (
                         select subject_id, floor(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))) / 60) m
                         from segments where user_id = _uid() and kind = 'study' group by subject_id) z), '{}'::jsonb)
  )
$$;

-- ───────── 대학 로고
create or replace function public.my_logos() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(univ_idx::text, data_url), '{}'::jsonb) from user_logos where user_id = _uid()
$$;
create or replace function public.logo_set(idx int, data_url text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if data_url is null then delete from user_logos where user_id = u and univ_idx = idx;
  else insert into user_logos(user_id, univ_idx, data_url) values (u, idx, data_url)
       on conflict (user_id, univ_idx) do update set data_url = excluded.data_url, updated_at = now();
  end if;
  perform _bump(u);
end $$;

-- ───────── 시험·수행평가
create or replace function public.exam_upsert(p jsonb, shift_quests boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); e exams; old_date date; delta int; moved int := 0;
begin
  if (p->>'room_id') is not null and not is_member((p->>'room_id')::uuid) then raise exception 'not_member'; end if;
  if p->>'id' is null then
    insert into exams(owner_id, room_id, title, exam_date, kind, subject_id, notify)
    values (u, (p->>'room_id')::uuid, trim(p->>'title'), (p->>'exam_date')::date, coalesce(p->>'kind', 'exam'),
            case when (p->>'room_id') is null then (p->>'subject_id')::uuid end, coalesce((p->>'notify')::boolean, false))
    returning * into e;
  else
    select * into e from exams where id = (p->>'id')::uuid and owner_id = u for update;
    if not found then raise exception 'not_found'; end if;
    old_date := e.exam_date;
    update exams set title = coalesce(nullif(trim(p->>'title'), ''), title), exam_date = coalesce((p->>'exam_date')::date, exam_date),
      kind = coalesce(p->>'kind', kind),
      subject_id = case when room_id is null and p ? 'subject_id' then (p->>'subject_id')::uuid else subject_id end,
      notify = coalesce((p->>'notify')::boolean, notify)
    where id = e.id returning * into e;
    delta := e.exam_date - old_date;
    -- 시험 날짜가 바뀌면, 선택한 경우에만 내 연결 퀘스트 마감일을 같은 만큼 옮김
    if shift_quests and delta <> 0 then
      update quests set due_date = due_date + delta where user_id = u and exam_id = e.id and due_date is not null and not done;
      get diagnostics moved = row_count;
    end if;
  end if;
  perform _bump(u);
  return to_jsonb(e) || jsonb_build_object('moved_quests', moved);
end $$;

-- 공동 일정에 연결해 둔 내 퀘스트의 마감일도 옮기고 싶을 때 (다른 사람이 날짜를 바꾼 경우)
create or replace function public.exam_shift_my_quests(eid uuid, delta int) returns int
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); n int;
begin
  update quests set due_date = due_date + delta where user_id = u and exam_id = eid and due_date is not null and not done;
  get diagnostics n = row_count; perform _bump(u); return n;
end $$;

create or replace function public.exam_delete(eid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  delete from exams where id = eid and owner_id = u;
  if not found then raise exception 'not_found'; end if;
  perform _bump(u);
end $$;

-- ───────── 우리 반
create or replace function public.room_join(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not exists (select 1 from profiles where id = u) then raise exception 'profile_required'; end if;
  insert into room_members(room_id, user_id) values (rid, u) on conflict do nothing; -- 초대·승인 없이 바로 참여
  perform _refresh_status(u); perform _bump(u);
end $$;

create or replace function public.room_leave(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  delete from room_members where room_id = rid and user_id = u;
  delete from group_participants gp using group_studies g where g.id = gp.group_id and g.room_id = rid and gp.user_id = u;
  perform _bump(u);
end $$;

-- 친구 목록 (이름순). 공유하는 항목만 내보낸다.
create or replace function public.room_board(rid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  return jsonb_build_object('server_now', now(), 'members', coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'me', s.user_id = u, 'display_name', s.display_name, 'state', s.state,
      'session_started_at', s.session_started_at, 'focus_since', s.focus_since, 'open_since', s.open_since,
      'break_since', s.break_since, 'today_date', s.today_date, 'today_closed_sec', s.today_closed_sec,
      'subject_label', s.subject_label, 'subject_color', s.subject_color, 'last_seen', pr.last_seen)
      order by s.display_name collate "C", s.user_id)
    from room_members m join member_status s on s.user_id = m.user_id left join member_presence pr on pr.user_id = m.user_id where m.room_id = rid), '[]'::jsonb));
end $$;

-- 랭킹 (선택 참여자만). metric: time = 실제 공부 시간, xp = 기간 중 얻은 XP. 둘은 별개.
create or replace function public.room_ranking(rid uuid, period text, metric text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); d0 date; t0 timestamptz;
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  d0 := case when period = 'week' then kst_day(now()) - ((extract(isodow from (now() at time zone 'UTC') + interval '9 hours')::int) - 1) else kst_day(now()) end;
  t0 := kst_midnight(d0);
  return jsonb_build_object('from', d0, 'me_opted_in', coalesce((select show_in_ranking from profiles where id = u), false), 'rows', coalesce((
    select jsonb_agg(row_to_json(z) order by z.value desc, z.display_name) from (
      select p.display_name, p.id = u as me,
        case when metric = 'xp' then
          (select coalesce(sum(r.xp), 0) from quest_rewards r join quests q on q.id = r.quest_id where r.user_id = p.id and r.active and q.done_at >= t0)
          + (select coalesce(sum(b.xp), 0) from xp_bonuses b where b.user_id = p.id and b.created_at >= t0)
        else
          (select coalesce(floor(sum(extract(epoch from (coalesce(g.ended_at, now()) - greatest(g.started_at, t0)))) / 60), 0)
             from segments g where g.user_id = p.id and g.kind = 'study' and coalesce(g.ended_at, now()) > t0)
        end as value
      from room_members m join profiles p on p.id = m.user_id
      where m.room_id = rid and p.show_in_ranking) z), '[]'::jsonb));
end $$;

-- 응원: 정해진 문구만, 같은 친구에게 10분에 한 번
create or replace function public.cheer_send(rid uuid, to_user uuid, preset int) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not is_member(rid) or not exists (select 1 from room_members where room_id = rid and user_id = to_user) then raise exception 'not_member'; end if;
  if to_user = u then raise exception 'self_cheer'; end if;
  if exists (select 1 from cheers c where c.from_user = u and c.to_user = cheer_send.to_user and c.created_at > now() - interval '10 minutes') then
    raise exception 'cheer_too_soon';
  end if;
  insert into cheers(room_id, from_user, to_user, preset) values (rid, u, to_user, preset);
end $$;

create or replace function public.cheers_recent(rid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'preset', c.preset, 'created_at', c.created_at,
           'from_name', pf.display_name, 'to_name', pt.display_name, 'to_me', c.to_user = _uid()) order by c.created_at desc), '[]'::jsonb)
  from (select * from cheers where room_id = rid and (to_user = _uid() or from_user = _uid()) order by created_at desc limit 30) c
  join profiles pf on pf.id = c.from_user join profiles pt on pt.id = c.to_user
$$;

-- 공동 자습: 시간·길이를 정해 두고, 원하는 사람만 참여. 내 타이머는 자동으로 켜지지 않는다.
create or replace function public.group_create(rid uuid, title text, starts_at timestamptz, duration_min int) returns uuid
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid(); gid uuid;
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  insert into group_studies(room_id, host_id, title, starts_at, duration_min) values (rid, u, trim(title), starts_at, duration_min) returning id into gid;
  insert into group_participants(group_id, user_id) values (gid, u);
  return gid;
end $$;
create or replace function public.group_join(gid uuid, join_it boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not exists (select 1 from group_studies g where g.id = gid and is_member(g.room_id) and not g.cancelled) then raise exception 'not_found'; end if;
  if join_it then insert into group_participants(group_id, user_id) values (gid, u) on conflict do nothing;
  else delete from group_participants where group_id = gid and user_id = u; end if;
end $$;
create or replace function public.group_cancel(gid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update group_studies set cancelled = true where id = gid and host_id = _uid();
  if not found then raise exception 'not_found'; end if;
end $$;
create or replace function public.group_list(rid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'starts_at', g.starts_at, 'duration_min', g.duration_min,
      'host_name', (select display_name from profiles where id = g.host_id), 'mine', g.host_id = u,
      'joined', exists (select 1 from group_participants p where p.group_id = g.id and p.user_id = u),
      'participants', (select coalesce(jsonb_agg(pp.display_name order by pp.display_name), '[]'::jsonb) from group_participants p join profiles pp on pp.id = p.user_id where p.group_id = g.id))
      order by g.starts_at)
    from group_studies g where g.room_id = rid and not g.cancelled and g.starts_at + make_interval(mins => g.duration_min) > now() - interval '1 hour'), '[]'::jsonb);
end $$;

-- 반 전체 공동 목표 (개인 목표와 별개): 기간 중 현재 구성원 전체의 공부 시간 합
create or replace function public.room_goal_create(rid uuid, title text, target_min int, starts_on date, ends_on date) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  insert into room_goals(room_id, created_by, title, target_min, starts_on, ends_on) values (rid, _uid(), trim(title), target_min, starts_on, ends_on) returning id into gid;
  return gid;
end $$;
create or replace function public.room_goal_delete(gid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from room_goals where id = gid and created_by = _uid();
  if not found then raise exception 'not_found'; end if;
end $$;
create or replace function public.room_goals_list(rid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := _uid();
begin
  if not is_member(rid) then raise exception 'not_member'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'target_min', g.target_min,
      'starts_on', g.starts_on, 'ends_on', g.ends_on, 'mine', g.created_by = u,
      'progress_min', (select coalesce(floor(sum(extract(epoch from (least(coalesce(s.ended_at, now()), kst_midnight(g.ends_on) + interval '1 day') - greatest(s.started_at, kst_midnight(g.starts_on))))) / 60), 0)
                       from segments s join room_members m on m.user_id = s.user_id and m.room_id = rid
                       where s.kind = 'study' and coalesce(s.ended_at, now()) > kst_midnight(g.starts_on) and s.started_at < kst_midnight(g.ends_on) + interval '1 day'))
      order by g.ends_on desc)
    from room_goals g where g.room_id = rid and g.ends_on >= kst_day(now()) - 30), '[]'::jsonb);
end $$;

-- ───────── 백업·기존 기록 이전
create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('format', 'studyquest-cloud-backup', 'version', 1, 'exported_at', now(),
    'profile', (select to_jsonb(p) from profiles p where id = _uid()),
    'subjects', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from subjects s where user_id = _uid()),
    'quests', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from quests q where user_id = _uid()),
    'segments', (select coalesce(jsonb_agg(to_jsonb(g)), '[]') from segments g where user_id = _uid()),
    'quest_rewards', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from quest_rewards r where user_id = _uid()),
    'xp_bonuses', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from xp_bonuses b where user_id = _uid()),
    'badges', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from user_badges b where user_id = _uid()),
    'exams', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from exams e where owner_id = _uid()),
    'legacy_baseline', (select to_jsonb(l) from legacy_baseline l where user_id = _uid()),
    'logos', (select coalesce(jsonb_object_agg(univ_idx::text, data_url), '{}') from user_logos where user_id = _uid()))
$$;

-- 같은 파일을 두 번 가져와도 legacy_id / legacy_key 로 중복 없이 처리
create or replace function public.import_legacy(p jsonb, overwrite_logos boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := _uid(); q jsonb; s jsonb; nq int := 0; ns int := 0; nr int := 0; nperf int := 0; nl int := 0; k text; v text; c int;
  qid uuid; nb jsonb; pre_badges int;
begin
  if not exists (select 1 from profiles where id = u) then raise exception 'profile_required'; end if;
  for q in select * from jsonb_array_elements(coalesce(p->'quests', '[]')) loop
    insert into quests(user_id, name, diff, plan_date, done, done_at, color_idx, legacy_id)
    values (u, left(q->>'name', 100), (q->>'diff')::smallint, (q->>'plan_date')::date, (q->>'done')::boolean,
            case when (q->>'done_at') is not null then to_timestamp((q->>'done_at')::bigint / 1000.0) end,
            coalesce((q->>'color_idx')::smallint, 0), q->>'legacy_id')
    on conflict (user_id, legacy_id) do nothing;
    get diagnostics c = row_count; nq := nq + c;
  end loop;
  for s in select * from jsonb_array_elements(coalesce(p->'segments', '[]')) loop
    select id into qid from quests where user_id = u and legacy_id = s->>'quest_legacy_id';
    insert into segments(user_id, kind, quest_id, started_at, ended_at, legacy_key)
    values (u, s->>'kind', qid, to_timestamp((s->>'start')::bigint / 1000.0), to_timestamp((s->>'end')::bigint / 1000.0), s->>'legacy_key')
    on conflict (user_id, legacy_key) do nothing;
    get diagnostics c = row_count; ns := ns + c;
  end loop;
  -- 완료된 이전 퀘스트의 보상은 원본에 저장된 XP 그대로
  for q in select * from jsonb_array_elements(coalesce(p->'quests', '[]')) where (value->>'done')::boolean and (value->>'xp') is not null loop
    select id into qid from quests where user_id = u and legacy_id = q->>'legacy_id';
    insert into quest_rewards(quest_id, user_id, lucky, minutes, xp, active, early, late, long, max_seg_min, first_done_at)
    values (qid, u, coalesce((q->>'lucky')::boolean, false), coalesce((q->>'minutes')::int, 0), (q->>'xp')::int, true,
            coalesce((q->>'early')::boolean, false), coalesce((q->>'late')::boolean, false), coalesce((q->>'long')::boolean, false),
            coalesce((q->>'max_seg_min')::int, 0), coalesce(to_timestamp((q->>'done_at')::bigint / 1000.0), now()))
    on conflict (quest_id) do nothing;
    get diagnostics c = row_count; nr := nr + c;
  end loop;
  for k in select jsonb_array_elements_text(coalesce(p->'perfect_days', '[]')) loop
    insert into xp_bonuses(user_id, kind, ref, xp, created_at) values (u, 'perfect', k, 50, kst_midnight(k::date)) on conflict do nothing;
    get diagnostics c = row_count; nperf := nperf + c;
  end loop;
  insert into legacy_baseline(user_id, totals) values (u, coalesce(p->'totals', '{}'))
  on conflict (user_id) do update set
    totals = (select jsonb_object_agg(key, greatest(coalesce((legacy_baseline.totals->>key)::numeric, 0), coalesce((excluded.totals->>key)::numeric, 0)))
              from (select jsonb_object_keys(legacy_baseline.totals || excluded.totals) key) kk),
    import_count = legacy_baseline.import_count + 1, imported_at = now();
  select count(*) into pre_badges from user_badges where user_id = u;
  insert into user_badges(user_id, badge_id)
  select u, b from jsonb_array_elements_text(coalesce(p->'badges', '[]')) b where exists (select 1 from badge_defs d where d.id = b)
  on conflict do nothing;
  for k, v in select key, value from jsonb_each_text(coalesce(p->'logos', '{}')) loop
    if overwrite_logos or not exists (select 1 from user_logos where user_id = u and univ_idx = k::int) then
      insert into user_logos(user_id, univ_idx, data_url) values (u, k::int, v)
      on conflict (user_id, univ_idx) do update set data_url = excluded.data_url, updated_at = now();
      nl := nl + 1;
    end if;
  end loop;
  nb := _evaluate_badges(u);
  perform _refresh_status(u); perform _bump(u);
  return jsonb_build_object('quests', nq, 'segments', ns, 'rewards', nr, 'perfect_days', nperf, 'logos', nl,
    'badges_added', (select count(*) from user_badges where user_id = u) - pre_badges,
    'skipped_quests', jsonb_array_length(coalesce(p->'quests', '[]')) - nq,
    'skipped_segments', jsonb_array_length(coalesce(p->'segments', '[]')) - ns);
end $$;

-- ───────── 권한: 로그인한 사용자만 서버 함수 호출. 내부 함수(_로 시작)는 직접 호출 불가.
revoke all on all functions in schema public from public;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' loop
    if f.proname like '\\_%' then
      execute format('revoke all on function %s from authenticated, anon', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
      execute format('revoke execute on function %s from anon', f.sig);
    end if;
  end loop;
end $$;
-- 정책 안에서 쓰는 함수는 authenticated 가 실행할 수 있어야 함
grant execute on function public.shares_room(uuid), public.is_member(uuid), public.kst_day(timestamptz), public.kst_midnight(date) to authenticated;

-- ───────── 실시간: 내 데이터 변경 신호, 반 친구 상태
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.user_heads, public.member_status, public.cheers;
  end if;
end $$;
`,k=`-- 테스트·로컬 체험용: Supabase 가 기본 제공하는 auth 스키마·역할을 최소한으로 흉내낸다.
-- 실제 Supabase 프로젝트에는 적용하지 않는다.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
`,f=Object.assign({"../../supabase/migrations/0001_schema.sql":x,"../../supabase/migrations/0002_badges_seed.sql":j,"../../supabase/migrations/0003_functions.sql":q}),l="sq.local.user";async function z(c){const{PGlite:_}=await w(async()=>{const{PGlite:e}=await import("./index-zd53BzQ3.js").then(n=>n.i);return{PGlite:e}},__vite__mapDeps([0,1,2]),import.meta.url);let p=c.persist,t;try{t=new _(c.persist?"idb://studyquest-local":void 0),await t.waitReady}catch{p=!1,t=new _,await t.waitReady}if(!(await t.query("select to_regclass('public.profiles')::text r")).rows[0].r){await t.exec(k);for(const e of Object.keys(f).sort())await t.exec(f[e]);await t.exec("grant select on all tables in schema public to authenticated;")}let i=null;try{const e=localStorage.getItem(l);e&&(i={id:e,email:null})}catch{}i&&await t.query("insert into auth.users(id) values ($1) on conflict do nothing",[i.id]);const d=new Set,u=new Set;async function m(e,n,r={}){const o=Object.keys(r).filter(a=>r[a]!==void 0),h=`select public.${n}(${o.map((a,s)=>`${a} => $${s+1}`).join(", ")}) as r`,y=o.map(a=>{const s=r[a];return Array.isArray(s)?`{${s.join(",")}}`:s!==null&&typeof s=="object"?JSON.stringify(s):s});try{return(await t.transaction(async s=>(await s.query("select set_config('request.jwt.claim.sub', $1, true)",[e]),await s.exec("set local role authenticated"),(await s.query(h,y)).rows)))[0]?.r}catch(a){throw new Error(a?.message??String(a))}}const b=e=>{e.startsWith("my_")||e==="app_bootstrap"||e==="timer_state"||e.startsWith("room_board")||e==="heartbeat"||queueMicrotask(()=>u.forEach(n=>(n.onMine(),n.onBoard(),e==="cheer_send"&&n.onCheer())))},g={mode:"local",persisted:p,async getUser(){return i},async signInWithGoogle(){const e=crypto.randomUUID();await t.query("insert into auth.users(id) values ($1) on conflict do nothing",[e]),i={id:e,email:null};try{localStorage.setItem(l,e)}catch{}d.forEach(n=>n(i))},async signOut(){i=null;try{localStorage.removeItem(l)}catch{}d.forEach(e=>e(null))},onAuthChange(e){return d.add(e),()=>d.delete(e)},async rpc(e,n={}){if(!i)throw new Error("not_authenticated");const r=await m(i.id,e,n);return b(e),r},subscribe(e,n){return u.add(n),n.onStatus("live"),()=>u.delete(n)}};return window.__sqLocal={addUser:e=>t.query("insert into auth.users(id) values ($1) on conflict do nothing",[e]),rpcAs:async(e,n,r={})=>{const o=await m(e,n,r);return b(n),o},sql:(e,n=[])=>t.query(e,n)},g}export{z as createLocalApi};
