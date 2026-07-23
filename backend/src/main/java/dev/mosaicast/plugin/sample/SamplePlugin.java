// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import dev.mosaicast.plugin.api.PluginBackend;
import dev.mosaicast.plugin.api.PluginContext;
import dev.mosaicast.plugin.api.Scope;
import java.time.Duration;
import java.util.List;
import org.pf4j.Extension;

/**
 * Reference {@link PluginBackend} implementation for the "Episode Highlight" sample: a podcaster-editable
 * markdown highlight at episode, feed and site scope.
 *
 * <p>Highlights themselves are read and written entirely through the host's generic doc-store HTTP
 * surface — this class never sees an individual read/write. Its only job is the one thing that surface
 * cannot do: <strong>aggregate</strong> across scopes. {@link #register(PluginContext)} schedules a
 * recurring recount of how many site episodes currently have a highlight, using {@link
 * PluginContext#feeds()} + {@link PluginContext#store()}, and stores the result back at
 * {@code Scope.site()} under {@code "stats"} for the site-scope Web Component to display.
 */
@Extension
public class SamplePlugin implements PluginBackend {

    /** Fallback used when the podcaster has not configured {@code refreshIntervalMinutes}. */
    static final int DEFAULT_REFRESH_MINUTES = 30;

    /** Mirrors the frontend's stored highlight shape ({@code { markdown: string } }) at every scope. */
    record Highlight(String markdown) {
    }

    /** Mirrors the frontend's {@code stats} doc shape, read at {@code data/site/main/stats}. */
    record HighlightStats(int totalEpisodes, int highlightedEpisodes) {
    }

    @Override
    public void register(PluginContext ctx) {
        int minutes = ctx.config().get("refreshIntervalMinutes", Integer.class, DEFAULT_REFRESH_MINUTES);
        // onSchedule throws for a non-positive duration, which disables the whole plugin at next startup
        // (ARCHITECTURE §7.8) — clamp defensively rather than trust a podcaster-editable config value.
        Duration interval = Duration.ofMinutes(Math.max(1, minutes));

        ctx.onSchedule(interval, () -> recomputeHighlightStats(ctx));
    }

    private static void recomputeHighlightStats(PluginContext ctx) {
        List<String> episodeIds = ctx.feeds().episodesIn(Scope.site());
        long highlighted = episodeIds.stream()
                .filter(id -> ctx.store().get(Scope.episode(id), "highlight", Highlight.class).isPresent())
                .count();
        ctx.store().put(Scope.site(), "stats", new HighlightStats(episodeIds.size(), (int) highlighted));
    }
}
