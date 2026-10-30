# skill-injector-plugin

English | [中文](README.zh.md)

A DeepSeek Harness plugin: **at the start of every new session, it automatically loads the skills you configured in settings into the Agent's "memory"**, so you no longer need to remind the Agent which skills to use in each session.

## What does it do?

The usual annoyance with skills is that in each new session the Agent does not necessarily know which skills are available, so you have to keep prompting it to "use the XXX skill".

This plugin turns that into a one-time configuration:

1. In settings, fill in the paths of your external skills (you can add several).
2. From the **next new session** on, every time a session starts, the plugin injects the full content of these skills into the Agent's context.
3. The Agent therefore "already knows" these skills from the start, with no further prompting from you.

## How to use

### Step 1: Install (skip if already installed)

Run this in the dsh repository directory:

```sh
dsh plugin --profile web add /Users/jdong/iproject/dsh/my-plugin/skill-injector-plugin
```

Then restart dsh (for example, run `dh-web`) so the plugin takes effect.

### Step 2: Configure the skill paths

In DSH's **settings document** `~/.dsh/settings.yaml`, add (or edit the existing) `skill-injector` section with your skill directory paths:

```yaml
skill-injector:
  skillPaths:
    - /Users/jdong/AI-D/AI-D-OB/Zuora/Dz-agent/skills
```

Changes **take effect immediately** (the settings file is hot-reloaded); open a new session to see the injection.

> Note: this plugin is a host plugin that runs on the command line. The `skill-injector` namespace it registers is currently **not shown in DSH's graphical settings UI** (a GUI configuration card needs an extra client component and a web frontend rebuild, which are not implemented yet). Configure it directly in `settings.yaml`.

> Each item in `skillPaths` can be:
> - A directory that holds many skills (recommended, such as the skills directory above)
> - A single skill directory (containing `SKILL.md`)
> - A single `.md` skill file

### Step 3: Start using it

Open a **new** session and just say what you want to do; the Agent will use the skills you configured automatically.

## Configuration (optional)

You can adjust these in the plugin's `cordis.patch.yml`:

| Option | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch; when `false` the plugin does nothing |
| `maxBytes` | `131072` | Size limit of the injected content in bytes. Lower it when there are too many or too large skills |

## Where the files are

```
my-plugin/skill-injector-plugin/
├── src/index.ts          # Plugin source
├── dist/                 # Compiled output
├── package.json          # Package definition
├── cordis.patch.yml      # How it mounts into a profile
└── smoke.test.mjs        # Local smoke test
```
