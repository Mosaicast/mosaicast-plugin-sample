// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.SitemapUrl;
import dev.mosaicast.plugin.sample.SamplePlugin.FavouriteCount;
import dev.mosaicast.plugin.sample.SamplePlugin.Highlight;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightStats;
import dev.mosaicast.plugin.testkit.FakeFeedAccess;
import dev.mosaicast.plugin.testkit.FakePluginContext;
import dev.mosaicast.plugin.testkit.InMemoryDocStore;
import dev.mosaicast.plugin.testkit.InMemoryPluginBlobs;
import dev.mosaicast.plugin.testkit.MapPluginConfig;
import dev.mosaicast.plugin.testkit.RecordingLogger.LogEvent;
import java.io.ByteArrayInputStream;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.event.Level;

/** Exercises {@link SamplePlugin} against the SDK test kit — no core, no database. */
class SamplePluginTest {

    /**
     * {@link SamplePlugin} keeps its context in a {@code static} field (see its javadoc for the PF4J
     * reason), so without this every test would inherit the previous one's context — a test that forgot to
     * {@code register()} would then pass for the wrong reason.
     */
    @BeforeEach
    void clearStaticContext() {
        SamplePlugin.clearContextForTests();
    }

    private static FakePluginContext contextWithEpisodes(MapPluginConfig config, String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        return new FakePluginContext(new InMemoryDocStore(), config, feeds, null);
    }

    /**
     * The same fixture, but with the store enforcing the manifest's {@code data.backendOwned} block — so a
     * write through {@link InMemoryDocStore#asUser(UUID)} (the test kit's stand-in for a client request)
     * fails where the host answers 403. Keep the pattern list identical to {@code plugin.json}: a malformed
     * or drifted entry protects nothing while looking like it does.
     */
    private static FakePluginContext contextEnforcingBackendOwnedKeys(String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        InMemoryDocStore store = new InMemoryDocStore().withBackendOwned("stats", "favourites");
        return new FakePluginContext(store, new MapPluginConfig(), feeds, null);
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
                Optional.of(new HighlightStats(3, 2, 1, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        // Three INFO lines: register() announcing the schedule, plus one per recompute pass — the eager one
        // register() runs itself, and the scheduled one the testkit runs synchronously on registration.
        assertEquals(3, ctx.logger().events(Level.INFO).size());
    }

    @Test
    void countsZeroWhenNoEpisodeHasAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    // The favourite tests below are the only ones that touch a USER scope, and they do it through
    // InMemoryDocStore.asUser(...) — the test kit's stand-in for the host resolving "me" from a session.
    // There is no production counterpart: no real DocStore can write into a user's partition, which is
    // exactly why the plugin reads them back through queryAcrossUsers instead of store().get(Scope.user()).

    @Test
    void countsEveryVisitorsFavouriteAndPublishesThePerEpisodeTotal() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        UUID alice = UUID.randomUUID();
        UUID bob = UUID.randomUUID();
        // What the frontend writes to data/user/me/fav:<slug> — the episode is in the key, because a user
        // partition is flat.
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(bob).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(bob).put(Scope.user(), "fav:ep-2", true);

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new FavouriteCount(2)),
                ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new FavouriteCount(1)),
                ctx.store().get(Scope.episode("ep-2"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 3)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void clearsAnEpisodesFavouriteCountWhenTheLastVisitorWithdrawsIt() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        UUID alice = UUID.randomUUID();
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-1", true);
        new SamplePlugin().register(ctx);
        assertTrue(ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class).isPresent());

        // The frontend DELETEs its own mark; the next recompute must remove the published count rather
        // than leave a stale one — or write a {"count": 0} the frontend would have to special-case.
        ctx.store().asUser(alice).delete(Scope.user(), "fav:ep-1");
        new SamplePlugin().register(ctx);

        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void ignoresFalseMarksAndMarksForEpisodesNoLongerInTheFeed() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        UUID alice = UUID.randomUUID();
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-1", false); // unfavourited but written, not deleted
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-gone", true); // episode dropped out of the feed

        new SamplePlugin().register(ctx);

        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    // Backend-owned keys (SDK 0.6.0). A shared-scope document has no owner: authorization on the host's data
    // surface is per plugin, not per document, so before 0.6.0 anything clearing this plugin's
    // `writableBy: podcaster` floor could PUT a forged `stats` and have it served to every visitor. That is
    // the attack the SDK's migration guide demonstrates against *this* plugin, verbatim.

    @Test
    void refusesAForgedClientWriteToABackendOwnedKeyWhileTheBackendKeepsWriting() {
        FakePluginContext ctx = contextEnforcingBackendOwnedKeys("ep-1");
        UUID podcaster = UUID.randomUUID();
        InMemoryDocStore client = ctx.store().asUser(podcaster);

        new SamplePlugin().register(ctx);

        // The backend's own write went through — that is the entire point of the declaration.
        HighlightStats computed = ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow();
        assertEquals(new HighlightStats(1, 0, 0, 0), computed);

        assertThrows(
                IllegalStateException.class,
                () -> client.put(Scope.site(), "stats", new HighlightStats(9999, 9999, 9999, 1337)));
        assertThrows(IllegalStateException.class, () -> client.delete(Scope.site(), "stats"));
        assertThrows(
                IllegalStateException.class,
                () -> client.put(Scope.episode("ep-1"), "favourites", new FavouriteCount(1337)));

        // Reads are untouched — `readableBy: anonymous` still governs them — and nothing was overwritten.
        assertEquals(Optional.of(computed), client.get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void leavesClientWrittenKeysWritableByClients() {
        FakePluginContext ctx = contextEnforcingBackendOwnedKeys("ep-1");
        InMemoryDocStore client = ctx.store().asUser(UUID.randomUUID());

        // `highlight` is the podcaster's to write and `fav:<slug>` is the visitor's own — neither is
        // declared, and declaring them would break the plugin rather than protect anything.
        client.put(Scope.episode("ep-1"), "highlight", new Highlight("written by a podcaster"));
        client.put(Scope.user(), "fav:ep-1", true);

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 1, 0, 1)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void repairsAKeyForgedBeforeTheDeclarationExistedAtStartupRatherThanAtTheNextTick() {
        FakePluginContext ctx = contextEnforcingBackendOwnedKeys("ep-1");
        // Seeded through the backend store because a client can no longer write it — this stands in for a
        // document already sitting in the table from before the plugin declared the key. `backendOwned`
        // refuses *new* client writes; it does not clean up, which is why register() recomputes eagerly
        // instead of leaving the forgery live until the first scheduled pass.
        ctx.store().put(Scope.site(), "stats", new HighlightStats(9999, 9999, 9999, 1337));
        ctx.store().put(Scope.episode("ep-1"), "favourites", new FavouriteCount(1337));

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        // The repair is only *timely* if register() recomputes itself: the testkit runs onSchedule
        // synchronously, so the assertions above would pass on the scheduled pass alone and prove nothing
        // about production, where that pass is a refreshIntervalMinutes wait away. Two recompute INFO lines
        // (plus register()'s own) is the observable difference between the eager pass and no eager pass.
        assertEquals(3, ctx.logger().events(Level.INFO).size());
    }

    @Test
    void prunesAndWarnsOnAHighlightDocWithMissingOrBlankMarkdown() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", "   "));
        ctx.store().put(Scope.episode("ep-2"), "highlight", Map.of("momentSeconds", 5));

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(2, warnings.size());
        assertTrue(warnings.get(0).message().contains("ep-1"));
        assertTrue(warnings.get(1).message().contains("ep-2"));
        // Pruned, not merely skipped: a contentless doc left in place warns on every recompute forever and
        // still reads as "present" to urls()/metaFor().
        assertTrue(ctx.store().query(Scope.episode("ep-1"), "highlight").isEmpty());
        assertTrue(ctx.store().query(Scope.episode("ep-2"), "highlight").isEmpty());
        assertTrue(warnings.get(0).message().contains("removed=true"));
    }

    @Test
    void pruningIsIdempotentAcrossRepeatedRecomputes() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", ""));

        // The testkit's onSchedule runs the task synchronously on register(), so registering twice is two
        // recompute passes: the first prunes, the second must find nothing left to prune and not warn again.
        new SamplePlugin().register(ctx);
        assertEquals(1, ctx.logger().events(Level.WARN).size());

        new SamplePlugin().register(ctx);

        assertEquals(1, ctx.logger().events(Level.WARN).size());
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void doesNotPublishAContentlessHighlightToTheSitemapOrOpenGraph() {
        // Reachable between scheduled prunes: the frontend writes the doc, recompute hasn't run yet.
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of("ep-1", "ep-2")))
                .withDisplay("ep-1", new DisplaySnapshot("Blank", null, null, null, null, null, null, null, null));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("   "));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("real content"));

        new SamplePlugin().register(ctx);

        assertEquals(Optional.empty(), new SamplePlugin().metaFor("highlight/ep-1"));
        assertEquals(List.of(new SitemapUrl("/p/sample/highlight/ep-2", null)), new SamplePlugin().urls());
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
    void metaForAndUrlsDegradeQuietlyWhenNoInstanceHasRegisteredYet() {
        // Core resolves ShareMetadataProvider/SitemapProvider independently of PluginBackend, so a lookup
        // can land here before register() ever ran. That must produce "nothing to contribute", not the
        // NullPointerException an unguarded `ctx.store()` would throw (which core's per-provider try/catch
        // swallows into a silently wrong page — the exact failure this plugin hit against a real core).
        assertEquals(Optional.empty(), new SamplePlugin().metaFor("highlight/ep-1"));
        assertEquals(List.of(), new SamplePlugin().urls());
    }

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

    /** A context whose blob store accepts PNGs, for the orphan-sweep tests below. */
    private static FakePluginContext contextWithBlobs(InMemoryPluginBlobs blobs, String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        return new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null, blobs);
    }

    /** Stores one small PNG and hands back its ref. */
    private static String storePng(InMemoryPluginBlobs blobs, String filename) {
        return blobs.put(filename, "image/png", new ByteArrayInputStream(new byte[] {1, 2, 3})).ref();
    }

    private static InMemoryPluginBlobs pngBlobs() {
        return new InMemoryPluginBlobs().withMimeTypes(Set.of("image/png"));
    }

    @Test
    void sweepsUploadedImagesNoHighlightPointsAtAnyMore() {
        InMemoryPluginBlobs blobs = pngBlobs();
        String live = storePng(blobs, "kept.png");
        String orphan = storePng(blobs, "dropped.png");
        FakePluginContext ctx = contextWithBlobs(blobs, "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "still here", "image", Map.of("ref", live, "alt", "a waveform")));

        new SamplePlugin().register(ctx);

        // The referenced one survives; the one nothing names is collected. Nothing else does this — a blob
        // outlives the document that pointed at it and only this plugin knows which those are.
        assertTrue(blobs.stat(live).isPresent(), "an image a highlight still names must survive the sweep");
        assertTrue(blobs.stat(orphan).isEmpty(), "an image nothing points at must be swept");
    }

    @Test
    void keepsImagesReferencedFromTheSiteScopeHighlight() {
        InMemoryPluginBlobs blobs = pngBlobs();
        String siteImage = storePng(blobs, "site.png");
        FakePluginContext ctx = contextWithBlobs(blobs, "ep-1");
        ctx.store().put(Scope.site(), "highlight",
                Map.of("markdown", "site-wide", "image", Map.of("ref", siteImage, "alt", "")));

        new SamplePlugin().register(ctx);

        // Regression guard for the sweep's own precondition: it walks Scope.site() as well as every
        // episode, so a site-scope image must not read as unreferenced.
        assertTrue(blobs.stat(siteImage).isPresent(), "a site-scope highlight's image must survive the sweep");
    }

    @Test
    void treatsAnUnreadableImageShapeAsNoReferenceRatherThanGuessing() {
        InMemoryPluginBlobs blobs = pngBlobs();
        String stored = storePng(blobs, "orphan.png");
        FakePluginContext ctx = contextWithBlobs(blobs, "ep-1");
        // A shape this plugin does not understand: `image` present but carrying no usable `ref`.
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "text", "image", Map.of("alt", "no ref here")));

        new SamplePlugin().register(ctx);

        // Reading it as "no reference" is the safe direction only because the blob it fails to protect is
        // one nothing can render anyway; the document itself is untouched.
        assertTrue(blobs.stat(stored).isEmpty());
        assertTrue(ctx.store().get(Scope.episode("ep-1"), "highlight", Highlight.class).isPresent()
                || !ctx.store().query(Scope.episode("ep-1"), "highlight").isEmpty(),
                "the highlight doc itself must not be pruned by the image sweep");
    }

    @Test
    void doesNothingWhenTheInstallHasNoBlobStorage() {
        // ctx.blobs() is null when the manifest declares no `blobs` block, or an operator refused it.
        // The whole recompute pass must still run rather than NPE on the sweep.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("no images here"));

        new SamplePlugin().register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 1, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }
}
