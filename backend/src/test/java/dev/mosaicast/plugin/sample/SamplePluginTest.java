// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.SitemapUrl;
import dev.mosaicast.plugin.sample.SamplePlugin.Highlight;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightStats;
import dev.mosaicast.plugin.testkit.FakeFeedAccess;
import dev.mosaicast.plugin.testkit.FakePluginContext;
import dev.mosaicast.plugin.testkit.InMemoryDocStore;
import dev.mosaicast.plugin.testkit.MapPluginConfig;
import dev.mosaicast.plugin.testkit.RecordingLogger.LogEvent;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.slf4j.event.Level;

/** Exercises {@link SamplePlugin} against the SDK test kit — no core, no database. */
class SamplePluginTest {

    private static FakePluginContext contextWithEpisodes(MapPluginConfig config, String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        return new FakePluginContext(new InMemoryDocStore(), config, feeds, null);
    }

    @Test
    void countsOnlyEpisodesThatHaveAHighlightAndTracksKeyMoments() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", "**great** episode", "momentSeconds", 90));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("another one"));
        // ep-2 deliberately left without a highlight.

        new SamplePlugin().register(ctx);

        assertEquals(1, ctx.scheduledCount());
        assertEquals(
                Optional.of(new HighlightStats(3, 2, 1)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        // One INFO line from register() (schedule set up) and one from the scheduled recompute itself.
        assertEquals(2, ctx.logger().events(Level.INFO).size());
    }

    @Test
    void countsZeroWhenNoEpisodeHasAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void skipsAndWarnsOnAHighlightDocWithMissingOrBlankMarkdown() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", "   "));
        ctx.store().put(Scope.episode("ep-2"), "highlight", Map.of("momentSeconds", 5));

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(2, warnings.size());
        assertTrue(warnings.get(0).message().contains("ep-1"));
        assertTrue(warnings.get(1).message().contains("ep-2"));
    }

    @Test
    void fallsBackToDefaultRefreshIntervalWhenUnconfigured() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");

        new SamplePlugin().register(ctx);

        // No "refreshIntervalMinutes" configured; the plugin still schedules (and runs, via the testkit's
        // synchronous onSchedule) using SamplePlugin.DEFAULT_REFRESH_MINUTES.
        assertEquals(1, ctx.scheduledCount());
        assertTrue(ctx.store().get(Scope.site(), "stats", HighlightStats.class).isPresent());
        assertTrue(ctx.logger().events(Level.WARN).isEmpty());
    }

    @Test
    void clampsNonPositiveConfiguredIntervalInsteadOfThrowingAndWarns() {
        MapPluginConfig config = new MapPluginConfig().with("refreshIntervalMinutes", 0);
        FakePluginContext ctx = contextWithEpisodes(config, "ep-1");

        // onSchedule throws for a non-positive Duration (ARCHITECTURE §7.8); a naive
        // Duration.ofMinutes(0) here would disable the whole plugin at next startup, so the plugin must
        // clamp to at least one minute instead of passing the configured value through unchanged.
        new SamplePlugin().register(ctx);

        assertEquals(1, ctx.scheduledCount());
        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).message().contains("refreshIntervalMinutes"));
    }

    // metaFor()/urls() below always register() on one SamplePlugin instance but call metaFor()/urls() on a
    // SEPARATE, freshly-constructed one — deliberately, because that's what PF4J actually does in production
    // (a fresh instance per extension-point type lookup, confirmed by booting a real core: register() ran on
    // one instance, metaFor()/urls() were invoked on others whose fields were never set, throwing a NPE). A
    // same-instance test here would pass even with a plain instance field and hide that bug; only a
    // static/classloader-scoped field (see SamplePlugin.ctx) survives across separate instances, and only a
    // cross-instance test proves it.

    @Test
    void metaForIsEmptyWhenSubpathIsNotAHighlightPage() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        new SamplePlugin().register(ctx);
        SamplePlugin lookedUpSeparately = new SamplePlugin();

        assertEquals(Optional.empty(), lookedUpSeparately.metaFor(null));
        assertEquals(Optional.empty(), lookedUpSeparately.metaFor(""));
        assertEquals(Optional.empty(), lookedUpSeparately.metaFor("other/ep-1"));
        assertEquals(Optional.empty(), lookedUpSeparately.metaFor("highlight/"));
    }

    @Test
    void metaForIsEmptyWhenEpisodeHasNoHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        new SamplePlugin().register(ctx);

        assertEquals(Optional.empty(), new SamplePlugin().metaFor("highlight/ep-1"));
    }

    @Test
    void metaForCombinesTheHighlightMarkdownWithTheFeedDisplaySnapshot() {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of("ep-1")))
                .withDisplay(
                        "ep-1",
                        new DisplaySnapshot(
                                "The Lighthouse", "show notes", null, null, null, "https://img.example/ep-1.png", null,
                                null, null));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null);
        ctx.store()
                .put(
                        Scope.episode("ep-1"),
                        "highlight",
                        new Highlight("# Great **moment**\n\nRight at `12:34` the band _finally_ (!) kicks in."));
        new SamplePlugin().register(ctx);

        Optional<OgMeta> meta = new SamplePlugin().metaFor("highlight/ep-1");

        assertEquals(
                Optional.of(new OgMeta(
                        "The Lighthouse", "Great moment Right at 12:34 the band finally ! kicks in.",
                        "https://img.example/ep-1.png")),
                meta);
    }

    @Test
    void urlsListsOnlyEpisodesThatHaveAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("first"));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("third"));
        new SamplePlugin().register(ctx);

        assertEquals(
                List.of(new SitemapUrl("/p/sample/highlight/ep-1", null), new SitemapUrl("/p/sample/highlight/ep-3", null)),
                new SamplePlugin().urls());
    }
}
