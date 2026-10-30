/**
 * skill-injector-plugin — auto-load configured external skills into memory.
 *
 * Reads a `skill-injector` settings section whose `skillPaths` names the
 * directories whose skills should be available. It does two things:
 *
 *  1. Registers the discovered skills as a standard `ctx.skills` provider, so
 *     they also appear in the DSH skill catalog and can be loaded with the
 *     `skill` tool.
 *  2. At the first `agent/pre-step` of each new session, reads the full body
 *     of every configured-path skill and injects it as one durable
 *     `<system-reminder>` user message — so the agent already has the skill
 *     instructions in memory and needs no per-session prompting.
 *
 * @module skill-injector-plugin
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
/** Durable message source tag for the auto-loaded skill payload. */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'skill-injector-memory': {
            kind: 'skill-injector-memory';
            form: 'instructions';
            paths: readonly string[];
            count: number;
        };
    }
}
/** Cordis plugin identity. */
export declare const name = "skill-injector-plugin";
/** Services this plugin requires to mount. */
export declare const inject: string[];
/** Plugin configuration (set in the profile's cordis.patch.yml). */
export interface Config {
    /** Master switch; when false the plugin loads but does nothing. */
    enabled?: boolean;
    /** Upper byte budget for the auto-loaded memory message. */
    maxBytes?: number;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    maxBytes: Schema<number, number>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    maxBytes: Schema<number, number>;
}>>;
/** Values stored in the `skill-injector` settings namespace. */
export interface SkillInjectorSettings {
    /** Directories whose skills should be discovered and injected. */
    skillPaths: string[];
}
/** Register lifecycle, provider, and per-session injection behavior. */
export declare function apply(ctx: Context, config: Config): void;
