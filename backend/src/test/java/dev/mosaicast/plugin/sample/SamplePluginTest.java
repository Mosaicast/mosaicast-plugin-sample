// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.sample.SamplePlugin.Highlight;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightStats;
import dev.mosaicast.plugin.testkit.FakeFeedAccess;
import dev.mosaicast.plugin.testkit.FakePluginContext;
import dev.mosaicast.plugin.testkit.InMemoryDocStore;
import dev.mosaicast.plugin.testkit.MapPluginConfig;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/** Exercises {@link SamplePlugin} against the SDK test kit — no core, no database. */
class SamplePluginTest {

    private static FakePluginContext contextWithEpisodes(MapPluginConfig config, String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        return new FakePluginContext(new InMemoryDocStore(), config, feeds, null);
    }

    @Test
    void countsOnlyEpisodesThatHaveAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("**great** episode"));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("another one"));
        // ep-2 deliberately left without a highlight.

        new SamplePlugin().register(ctx);

        assertEquals(1, ctx.scheduledCount());
        assertEquals(
                Optional.of(new HighlightStats(3, 2)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void countsZeroWhenNoEpisodeHasAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void fallsBackToDefaultRefreshIntervalWhenUnconfigured() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");

        new SamplePlugin().register(ctx);

        // No "refreshIntervalMinutes" configured; the plugin still schedules (and runs, via the testkit's
        // synchronous onSchedule) using SamplePlugin.DEFAULT_REFRESH_MINUTES.
        assertEquals(1, ctx.scheduledCount());
        assertTrue(ctx.store().get(Scope.site(), "stats", HighlightStats.class).isPresent());
    }

    @Test
    void clampsNonPositiveConfiguredIntervalInsteadOfThrowing() {
        MapPluginConfig config = new MapPluginConfig().with("refreshIntervalMinutes", 0);
        FakePluginContext ctx = contextWithEpisodes(config, "ep-1");

        // onSchedule throws for a non-positive Duration (ARCHITECTURE §7.8); a naive
        // Duration.ofMinutes(0) here would disable the whole plugin at next startup, so the plugin must
        // clamp to at least one minute instead of passing the configured value through unchanged.
        new SamplePlugin().register(ctx);

        assertEquals(1, ctx.scheduledCount());
    }
}
