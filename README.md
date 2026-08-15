# Parking Availability App

A hobby project to find likely parking availability near a destination,
using historical city data, OpenStreetMap, and an LLM synthesis layer.

## Setup

Before running any import scripts, create a local `.env` file based on
[`.env.example`](.env.example):

```bash
cp .env.example .env
```

Then fill in the real values in `.env` (Supabase project URL and service
role key -- both available in the Supabase dashboard under
Project Settings > API). `.env` is gitignored and must never be committed.
