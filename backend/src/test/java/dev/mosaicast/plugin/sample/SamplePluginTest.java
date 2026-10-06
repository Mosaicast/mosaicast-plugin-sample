// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.ExportFile;
import dev.mosaicast.plugin.api.UserExport;
import dev.mosaicast.plugin.api.FeedAccess;
import dev.mosaicast.plugin.api.EpisodePhase;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.Role;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.SearchHit;
import dev.mosaicast.plugin.api.NotifyMessage;
import dev.mosaicast.plugin.api.SitemapUrl;
import dev.mosaicast.plugin.api.TranslationException;
import dev.mosaicast.plugin.sample.SamplePlugin.AnnouncedLocales;
import dev.mosaicast.plugin.sample.SamplePlugin.FavouriteCount;
import dev.mosaicast.plugin.sample.SamplePlugin.Highlight;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightIndex;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightStats;
import dev.mosaicast.plugin.sample.SamplePlugin.HighlightTranslation;
import dev.mosaicast.plugin.sample.SamplePlugin.IndexEntry;
import dev.mosaicast.plugin.sample.SamplePlugin.TranslationDrafts;
import dev.mosaicast.plugin.testkit.FakeFeedAccess;
import dev.mosaicast.plugin.testkit.FakeLocales;
import dev.mosaicast.plugin.testkit.FakeNotifier;
import dev.mosaicast.plugin.testkit.FakePluginContext;
import dev.mosaicast.plugin.testkit.FakeTags;
import dev.mosaicast.plugin.testkit.FakeTranslation;
import dev.mosaicast.plugin.testkit.FakeUsers;
import dev.mosaicast.plugin.testkit.InMemoryDocStore;
import dev.mosaicast.plugin.testkit.InMemoryPluginBlobs;
import dev.mosaicast.plugin.testkit.MapPluginConfig;
import dev.mosaicast.plugin.testkit.PageRouteProviderHarness;
import dev.mosaicast.plugin.testkit.RecordingLogger.LogEvent;
import dev.mosaicast.plugin.testkit.SearchProviderHarness;
import dev.mosaicast.plugin.testkit.SitemapProviderHarness;
import dev.mosaicast.plugin.testkit.UserDataHandlerHarness;
import java.io.ByteArrayInputStream;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.event.Level;

/** Exercises {@link SamplePlugin} against the SDK test kit — no core, no database. */
class SamplePluginTest {

    /**
     * The instance under test, and there is deliberately only one of it.
     *
     * <p>Core installs PF4J's {@code SingletonExtensionFactory} (since 0.6.7), so every extension point —
     * {@code PluginBackend}, {@code ShareMetadataProvider}, {@code SitemapProvider}, the rest — resolves to
     * the object {@code register()} ran on. Registering one instance here and calling providers on the same
     * one is therefore what the host does, and the tests that used to build a second instance were pinning
     * a workaround for a PF4J default core no longer uses.
     *
     * <p>JUnit builds a fresh test-class instance per method, so this field is also what makes a test that
     * never calls {@code register()} genuinely unregistered — the job the old {@code static} field needed a
     * {@code @BeforeEach} reset for.
     */
    private final SamplePlugin plugin = new SamplePlugin();

    /**
     * The site's episodes, every one **released** — what a fixture meant before SDK 0.18.0 gave episodes a
     * phase. A slug with no snapshot is treated as quiet ({@code isQuiet} fails closed when the host cannot
     * say), so a bare {@code FakeFeedAccess} would now hide every highlight; tests about quiet episodes move
     * one with {@link FakeFeedAccess#withPhase(String, EpisodePhase)}.
     */
    private static FakeFeedAccess released(String... episodeIds) {
        FakeFeedAccess feeds = new FakeFeedAccess(Map.of(Scope.site(), List.of(episodeIds)));
        for (String id : episodeIds) {
            feeds.withDisplay(id, new DisplaySnapshot(id, null, null, null, null, null, null, null, null, ""))
                    .withPhase(id, EpisodePhase.RELEASED);
        }
        return feeds;
    }

    private static FakePluginContext contextWithEpisodes(MapPluginConfig config, String... episodeIds) {
        FakeFeedAccess feeds = released(episodeIds);
        return new FakePluginContext(new InMemoryDocStore(), config, feeds, null).withReadsAllUsers();
    }

    /**
     * The same fixture, but with the store enforcing the manifest's {@code data.backendOwned} block — so a
     * write through {@link InMemoryDocStore#asUser(UUID)} (the test kit's stand-in for a client request)
     * fails where the host answers 403. Keep the pattern list identical to {@code plugin.json}: a malformed
     * or drifted entry protects nothing while looking like it does.
     */
    private static FakePluginContext contextEnforcingBackendOwnedKeys(String... episodeIds) {
        FakeFeedAccess feeds = released(episodeIds);
        InMemoryDocStore store = new InMemoryDocStore()
                .withBackendOwned("stats", "favourites", "index", "drafts", "announced");
        return new FakePluginContext(store, new MapPluginConfig(), feeds, null).withReadsAllUsers();
    }

    @Test
    void countsOnlyEpisodesThatHaveAHighlightAndTracksKeyMoments() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", "**great** episode", "momentSeconds", 90));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("another one"));
        // ep-2 deliberately left without a highlight.

        plugin.register(ctx);

        assertEquals(1, ctx.scheduledCount());
        assertEquals(
                Optional.of(new HighlightStats(3, 2, 1, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        // Three INFO lines: register() announcing the schedule, plus one per recompute pass — the eager one
        // register() runs itself, and the scheduled one the testkit runs synchronously on registration.
        assertEquals(3, ctx.logger().events(Level.INFO).size());
    }

    @Test
    void countsZeroWhenNoEpisodeHasAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    // The favourite tests below are the only ones that touch a USER scope, and they do it through
    // InMemoryDocStore.asUser(...) — the test kit's stand-in for the host resolving "me" from a session.
    // There is no production counterpart: no real DocStore can write into a user's partition, which is
    // exactly why the plugin reads them back through ctx.allUsers().query(...) instead of store().get(Scope.user()).

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

        plugin.register(ctx);

        assertEquals(
                Optional.of(new FavouriteCount(2)),
                ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new FavouriteCount(1)),
                ctx.store().get(Scope.episode("ep-2"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 3, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void refusesToTallyFavouritesWithoutTheReadsAllUsersDeclaration() {
        // What the host hands a plugin whose manifest dropped `data.readsAllUsers`: `allUsers()` is null.
        // Degrading to an empty tally would publish "nobody favourited anything" as a fact, so the recompute
        // in register() throws instead — and the host refuses to load a plugin whose register() throws,
        // which is the loud failure a manifest/code disagreement deserves.
        FakeFeedAccess feeds = released("ep-1");
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null);
        ctx.store().asUser(UUID.randomUUID()).put(Scope.user(), "fav:ep-1", true);

        IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> plugin.register(ctx));

        assertTrue(thrown.getMessage().contains("data.readsAllUsers"), thrown.getMessage());
        assertTrue(ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class).isEmpty());
    }

    @Test
    void clearsAnEpisodesFavouriteCountWhenTheLastVisitorWithdrawsIt() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        UUID alice = UUID.randomUUID();
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-1", true);
        plugin.register(ctx);
        assertTrue(ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class).isPresent());

        // The frontend DELETEs its own mark; the next recompute must remove the published count rather
        // than leave a stale one — or write a {"count": 0} the frontend would have to special-case.
        ctx.store().asUser(alice).delete(Scope.user(), "fav:ep-1");
        plugin.register(ctx);

        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void ignoresFalseMarksAndMarksForEpisodesNoLongerInTheFeed() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        UUID alice = UUID.randomUUID();
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-1", false); // unfavourited but written, not deleted
        ctx.store().asUser(alice).put(Scope.user(), "fav:ep-gone", true); // episode dropped out of the feed

        plugin.register(ctx);

        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0, 0, 0)),
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

        plugin.register(ctx);

        // The backend's own write went through — that is the entire point of the declaration.
        HighlightStats computed = ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow();
        assertEquals(new HighlightStats(1, 0, 0, 0, 0, 0), computed);

        assertThrows(
                IllegalStateException.class,
                () -> client.put(Scope.site(), "stats", new HighlightStats(9999, 9999, 9999, 1337, 0, 0)));
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

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 1, 0, 1, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void repairsAKeyForgedBeforeTheDeclarationExistedAtStartupRatherThanAtTheNextTick() {
        FakePluginContext ctx = contextEnforcingBackendOwnedKeys("ep-1");
        // Seeded through the backend store because a client can no longer write it — this stands in for a
        // document already sitting in the table from before the plugin declared the key. `backendOwned`
        // refuses *new* client writes; it does not clean up, which is why register() recomputes eagerly
        // instead of leaving the forgery live until the first scheduled pass.
        ctx.store().put(Scope.site(), "stats", new HighlightStats(9999, 9999, 9999, 1337, 0, 0));
        ctx.store().put(Scope.episode("ep-1"), "favourites", new FavouriteCount(1337));

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0, 0, 0)),
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

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 0, 0, 0, 0, 0)),
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
        plugin.register(ctx);
        assertEquals(1, ctx.logger().events(Level.WARN).size());

        plugin.register(ctx);

        assertEquals(1, ctx.logger().events(Level.WARN).size());
        assertEquals(
                Optional.of(new HighlightStats(1, 0, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void doesNotPublishAContentlessHighlightToTheSitemapOrOpenGraph() {
        // Reachable between scheduled prunes: the frontend writes the doc, recompute hasn't run yet.
        FakeFeedAccess feeds = released("ep-1", "ep-2")
                .withDisplay("ep-1", new DisplaySnapshot("Blank", null, null, null, null, null, null, null, null, ""));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers();
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("   "));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("real content"));

        plugin.register(ctx);

        assertEquals(Optional.empty(), plugin.metaFor("highlight/ep-1"));
        assertEquals(List.of(new SitemapUrl("/p/sample/highlight/ep-2", null)), plugin.urls());
    }

    @Test
    void fallsBackToDefaultRefreshIntervalWhenUnconfigured() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");

        plugin.register(ctx);

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
        plugin.register(ctx);

        assertEquals(1, ctx.scheduledCount());
        // Warned once, not once per read: register() reads the period for its log line and the test kit
        // reads it again when the supplier is registered, and the second read sees no change.
        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).message().contains("refreshIntervalMinutes"));
    }

    @Test
    void reschedulesWhenThePodcasterEditsTheRefreshInterval() {
        // The bug SDK 0.15.0's Supplier overload exists for, in one assertion. `refreshIntervalMinutes` is
        // `editableBy: "podcaster"`, so its value is expected to change under a running plugin — but the
        // Duration overload captures the period during register() and the host holds it for the life of
        // the process. The podcaster's save then succeeds, reads back correctly, and changes nothing until
        // core restarts. `scheduledPeriods()` re-reads every registered supplier, so a plugin that
        // captured a Duration keeps reporting 30 here and fails.
        MapPluginConfig config = new MapPluginConfig().with("refreshIntervalMinutes", 30);
        FakePluginContext ctx = contextWithEpisodes(config, "ep-1");

        plugin.register(ctx);
        assertEquals(List.of(Duration.ofMinutes(30)), ctx.scheduledPeriods());

        config.with("refreshIntervalMinutes", 5);
        assertEquals(List.of(Duration.ofMinutes(5)), ctx.scheduledPeriods());

        // The change is announced once, at the transition — not on every consultation. The host calls the
        // supplier before every fire, so an unconditional line would bury the log at exactly the cadence
        // the operator is trying to tune.
        ctx.scheduledPeriods();
        List<LogEvent> changes = ctx.logger().events(Level.INFO).stream()
                .filter(e -> e.message().contains("rescheduling"))
                .toList();
        assertEquals(1, changes.size());
    }

    @Test
    void clampsAConfiguredIntervalThatTurnsNonPositiveAfterRegistration() {
        // Only the value at registration is strict — after that the host tolerates a bad answer and keeps
        // the last valid period. This plugin does not lean on that: it clamps on every read, so a
        // podcaster who saves a 0 gets a one-minute recompute rather than a schedule frozen at whatever it
        // happened to be. The second WARN is the transition, and there is exactly one of them.
        MapPluginConfig config = new MapPluginConfig().with("refreshIntervalMinutes", 15);
        FakePluginContext ctx = contextWithEpisodes(config, "ep-1");
        plugin.register(ctx);
        assertTrue(ctx.logger().events(Level.WARN).isEmpty());

        config.with("refreshIntervalMinutes", 0);
        assertEquals(List.of(Duration.ofMinutes(1)), ctx.scheduledPeriods());
        assertEquals(List.of(Duration.ofMinutes(1)), ctx.scheduledPeriods());

        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).message().contains("refreshIntervalMinutes"));
    }

    // metaFor()/urls() below register and then call providers on the ONE instance, which is what core does:
    // its PF4J SingletonExtensionFactory caches by class, so every extension-point lookup returns the object
    // register() ran on. These tests used to build a second instance on purpose, pinning PF4J's *default*
    // factory (a fresh object per extension-point type — register() on one, metaFor()/urls() on others whose
    // fields were never set, confirmed as a live NPE against a pre-0.6.7 core). The next test still covers
    // what survived that fix: a lookup can arrive before register() has run.

    @Test
    void metaForAndUrlsDegradeQuietlyWhenNothingHasRegisteredYet() {
        // Core resolves ShareMetadataProvider/SitemapProvider independently of PluginBackend, so a lookup
        // can land here before register() ever ran. That must produce "nothing to contribute", not the
        // NullPointerException an unguarded `ctx.store()` would throw (which core's per-provider try/catch
        // swallows into a silently wrong page — the exact failure this plugin hit against a real core).
        assertEquals(Optional.empty(), plugin.metaFor("highlight/ep-1"));
        assertEquals(List.of(), plugin.urls());
    }

    @Test
    void metaForIsEmptyWhenSubpathIsNotAHighlightPage() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        plugin.register(ctx);

        assertEquals(Optional.empty(), plugin.metaFor(null));
        assertEquals(Optional.empty(), plugin.metaFor(""));
        assertEquals(Optional.empty(), plugin.metaFor("other/ep-1"));
        assertEquals(Optional.empty(), plugin.metaFor("highlight/"));
    }

    @Test
    void metaForIsEmptyWhenEpisodeHasNoHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        plugin.register(ctx);

        assertEquals(Optional.empty(), plugin.metaFor("highlight/ep-1"));
    }

    @Test
    void metaForCombinesTheHighlightMarkdownWithTheFeedDisplaySnapshot() {
        FakeFeedAccess feeds = released("ep-1")
                .withDisplay(
                        "ep-1",
                        new DisplaySnapshot(
                                "The Lighthouse", "show notes", null, null, null, "https://img.example/ep-1.png", null,
                                null, null, ""));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers();
        ctx.store()
                .put(
                        Scope.episode("ep-1"),
                        "highlight",
                        new Highlight("# Great **moment**\n\nRight at `12:34` the band _finally_ (!) kicks in."));
        plugin.register(ctx);

        Optional<OgMeta> meta = plugin.metaFor("highlight/ep-1");

        assertEquals(
                Optional.of(new OgMeta(
                        "The Lighthouse", "Great moment Right at 12:34 the band finally ! kicks in.",
                        "https://img.example/ep-1.png")),
                meta);
    }

    @Test
    void leavesOgLocaleToTheHostBecauseThisPageFollowsTheShell() {
        // SDK 0.12.0, and the one assertion that came out of running this against a real core rather than a
        // harness. OgMeta.locale is for a page fixed in ONE language; this page renders whichever translation
        // the shell's locale picks, so the host's resolved locale is already right. Naming one here would put
        // og:locale=en_US and <html lang="en"> on exactly the ?lang=de URL that urls() declares a German
        // alternate for — one plugin making two contradictory claims about one URL.
        FakeFeedAccess feeds = released("ep-1")
                .withDisplay("ep-1",
                        new DisplaySnapshot("Der Leuchtturm", null, null, null, null, null, null, null, null, ""));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers()
                .withLocales(FakeLocales.englishOnly().withUi("de").withDefault("de"));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                new Highlight("Der Leuchtturm", Map.of("en", new HighlightTranslation("The lighthouse"))));
        plugin.register(ctx);

        assertNull(plugin.metaFor("highlight/ep-1").orElseThrow().locale());
    }

    @Test
    void urlsListsOnlyEpisodesThatHaveAHighlight() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("first"));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("third"));
        plugin.register(ctx);

        var sitemap = new SitemapProviderHarness("sample", plugin).collect();

        assertTrue(sitemap.problems().isEmpty(), "nothing the host would drop or contradict");
        assertEquals(
                List.of("/p/sample/highlight/ep-1", "/p/sample/highlight/ep-3"),
                sitemap.locations());
    }

    // hreflang alternates (SDK 0.12.0, ARCHITECTURE §6.6/§12.7). Core emits none for a plugin entry unless the
    // plugin declares them — it cannot read these documents, so it will not guess which languages they exist
    // in. What follows is the three-way filter that makes the declaration true, one test per way it can lie.

    @Test
    void declaresATranslationGroupNamingItsOwnLanguageAndEveryLanguageItIsReadableIn() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1")
                .withLocales(FakeLocales.englishOnly().withUi("de"));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                new Highlight("the lighthouse", Map.of("de", new HighlightTranslation("der Leuchtturm"))));
        plugin.register(ctx);

        var sitemap = new SitemapProviderHarness("sample", plugin).collect();

        assertTrue(sitemap.problems().isEmpty());
        assertEquals(List.of("de", "en"), sitemap.locales("/p/sample/highlight/ep-1"));
        // One path per language: the host appends ?lang=de itself and leaves the default on the bare URL.
        assertEquals(
                Map.of("en", "/p/sample/highlight/ep-1", "de", "/p/sample/highlight/ep-1"),
                sitemap.alternates("/p/sample/highlight/ep-1"));
    }

    @Test
    void leavesOutALanguageTheShellCannotRenderEvenThoughItWasAuthoredIn() {
        // The reason available() and contentLocales() are two lists. An operator can require a Dutch imprint
        // without offering a Dutch UI, so `nl` is a legitimate content language with no ?lang=nl behind it —
        // the alternate would resolve to English and contradict its own hreflang. Core applies exactly this
        // filter to its own legal pages and deliberately does not apply it to a plugin's entries.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1")
                .withLocales(FakeLocales.englishOnly().withUi("de").withContent("nl"));
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the lighthouse", Map.of(
                "de", new HighlightTranslation("der Leuchtturm"),
                "nl", new HighlightTranslation("de vuurtoren"))));
        plugin.register(ctx);

        var sitemap = new SitemapProviderHarness("sample", plugin).collect();

        assertEquals(List.of("de", "en"), sitemap.locales("/p/sample/highlight/ep-1"));
    }

    @Test
    void leavesOutAForgedLocaleKeyAndOneWhoseTabWasNeverFilledIn() {
        // These keys sit inside a JSON value, so the host's doc-key validation never saw them: they are
        // client input. Unreachable in the UI, which the frontend can shrug at — and in sitemap.xml, this
        // plugin telling a crawler a language exists. A blank tab is not a translation either.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1")
                .withLocales(FakeLocales.englishOnly().withUi("de"));
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the lighthouse", Map.of(
                "de", new HighlightTranslation("der Leuchtturm"),
                "zz", new HighlightTranslation("forged"),
                "fr", new HighlightTranslation("   "))));
        plugin.register(ctx);

        var sitemap = new SitemapProviderHarness("sample", plugin).collect();

        assertTrue(sitemap.problems().isEmpty());
        assertEquals(List.of("de", "en"), sitemap.locales("/p/sample/highlight/ep-1"));
    }

    @Test
    void makesNoLanguageClaimAtAllForAHighlightNobodyTranslated() {
        // The empty map is not a degraded answer, it is the pre-0.12.0 behaviour and the honest one: a group
        // of one says "this page exists, in one language", which is not a translation group. A single-language
        // site therefore emits exactly what it emitted before this feature existed.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2")
                .withLocales(FakeLocales.englishOnly().withUi("de"));
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("only ever written once"));
        ctx.store().put(Scope.episode("ep-2"), "highlight",
                new Highlight("translated", Map.of("de", new HighlightTranslation("übersetzt"))));
        plugin.register(ctx);

        var sitemap = new SitemapProviderHarness("sample", plugin).collect();

        assertEquals(List.of(), sitemap.locales("/p/sample/highlight/ep-1"));
        assertEquals(List.of("de", "en"), sitemap.locales("/p/sample/highlight/ep-2"));
    }

    /** A context whose blob store accepts PNGs, for the orphan-sweep tests below. */
    private static FakePluginContext contextWithBlobs(InMemoryPluginBlobs blobs, String... episodeIds) {
        return contextWithBlobs(blobs, new MapPluginConfig(), episodeIds);
    }

    /** The same, with an {@code imageSweep} value configured. */
    private static FakePluginContext contextWithBlobs(InMemoryPluginBlobs blobs, MapPluginConfig config,
                                                      String... episodeIds) {
        FakeFeedAccess feeds = released(episodeIds);
        return new FakePluginContext(new InMemoryDocStore(), config, feeds, null, blobs).withReadsAllUsers();
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

        plugin.register(ctx);

        // The referenced one survives; the one nothing names is collected. Nothing else does this — a blob
        // outlives the document that pointed at it and only this plugin knows which those are.
        assertTrue(blobs.stat(live).isPresent(), "an image a highlight still names must survive the sweep");
        assertTrue(blobs.stat(orphan).isEmpty(), "an image nothing points at must be swept");
    }

    @Test
    void reportsOrphansWithoutDeletingThemWhenImageSweepIsReport() {
        InMemoryPluginBlobs blobs = pngBlobs();
        String orphan = storePng(blobs, "dropped.png");
        MapPluginConfig config = new MapPluginConfig().with("imageSweep", SamplePlugin.SWEEP_REPORT);
        FakePluginContext ctx = contextWithBlobs(blobs, config, "ep-1");

        plugin.register(ctx);

        // The dry run an operator wants before letting anything delete their files for the first time.
        assertTrue(blobs.stat(orphan).isPresent(), "report mode must not delete anything");
        List<LogEvent> reports = ctx.logger().events(Level.INFO).stream()
                .filter(e -> e.message().contains("imageSweep=report"))
                .toList();
        // Once per recompute, and register() does two: the eager pass, then the test kit's onSchedule
        // running the task synchronously. Unlike the refresh-interval logging this is deliberately not
        // deduplicated — it runs per recompute rather than per scheduler consultation, and it reports a
        // state that is actively holding storage.
        assertEquals(2, reports.size());
        // The refs, not just a count: a number tells an operator nothing they can go and check.
        assertTrue(reports.get(0).message().contains(orphan),
                "report mode must name the orphans it left in place");
    }

    @Test
    void refusesToDeleteOnAnImageSweepValueItDoesNotUnderstand() {
        // `options` closes this door at write time and at load for the manifest's own default, but it
        // cannot un-store a value written before the field declared one. The fallback is the SAFE branch,
        // not the default one: refusing to delete on a value we do not understand costs storage, and the
        // other way costs files.
        InMemoryPluginBlobs blobs = pngBlobs();
        String orphan = storePng(blobs, "dropped.png");
        MapPluginConfig config = new MapPluginConfig().with("imageSweep", "reprot");
        FakePluginContext ctx = contextWithBlobs(blobs, config, "ep-1");

        plugin.register(ctx);

        assertTrue(blobs.stat(orphan).isPresent(), "an unrecognised imageSweep must not delete anything");
        // Two, for the two recompute passes register() performs (eager, then the test kit's synchronous
        // onSchedule) — not one per scheduler tick.
        List<LogEvent> warnings = ctx.logger().events(Level.WARN);
        assertEquals(2, warnings.size());
        assertTrue(warnings.get(0).message().contains("imageSweep"));
    }

    @Test
    void keepsImagesReferencedFromTheSiteScopeHighlight() {
        InMemoryPluginBlobs blobs = pngBlobs();
        String siteImage = storePng(blobs, "site.png");
        FakePluginContext ctx = contextWithBlobs(blobs, "ep-1");
        ctx.store().put(Scope.site(), "highlight",
                Map.of("markdown", "site-wide", "image", Map.of("ref", siteImage, "alt", "")));

        plugin.register(ctx);

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

        plugin.register(ctx);

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

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 1, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    /**
     * The listing the plugin's own page renders from (2.11.0).
     *
     * <p>A browser cannot build this: the doc surface is addressed by scope and key, so "every episode's
     * highlight" is one request per episode. The backend already walks that set on its schedule, so it
     * publishes the answer as one document — and because it is derived, it is declared `backendOwned`, so
     * no client can publish a listing of its own.
     */
    @Test
    void publishesAnIndexOfEveryHighlightForThePage() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2", "ep-3");
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "**the drop**", "momentSeconds", 90,
                        "image", Map.of("ref", "blob-1", "alt", "a lighthouse")));
        ctx.store().put(Scope.episode("ep-3"), "highlight", new Highlight("no moment, no picture"));
        // ep-2 has no highlight, so it must not appear at all.

        plugin.register(ctx);

        HighlightIndex index = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow();
        assertEquals(List.of("ep-1", "ep-3"), index.entries().stream().map(IndexEntry::slug).toList());

        IndexEntry first = index.entries().get(0);
        assertEquals(90, first.momentSeconds());
        assertEquals("blob-1", first.imageRef());
        // The excerpt is plain text: a card renders it as a string, so markdown punctuation would show
        // through as literal asterisks rather than as emphasis.
        assertFalse(first.excerpt().contains("*"), "excerpt must be stripped of markdown: " + first.excerpt());
        assertTrue(first.excerpt().contains("the drop"));

        IndexEntry second = index.entries().get(1);
        assertNull(second.momentSeconds(), "an episode with no key moment carries none");
        assertNull(second.imageRef(), "an episode with no picture carries none");
    }

    @Test
    void excerptSaysWhatThePageSaysNotItsMarkup() {
        // Found against a running core: a table and a stray <style> reached og:description and the search
        // snippet verbatim. Escaped, so harmless — and still not what the page shows, which ctx.sanitize
        // renders without the style block and without the table's delimiter row.
        String markdown = "Forty years.\n\n| Left | Centre |\n|:-----|:------:|\n| a | b |\n\n"
                + "<style>body{display:none}</style><p style=\"color:red\">styled</p>";

        assertEquals("Forty years. Left Centre a b styled", SamplePlugin.excerpt(markdown));
    }

    @Test
    void indexOmitsAContentlessHighlightItJustPruned() {
        // The prune and the listing come from the same pass on purpose. Published from a second walk, the
        // page could list an episode whose doc this pass had already removed.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of("markdown", "   "));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("a real one"));

        plugin.register(ctx);

        HighlightIndex index = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow();
        assertEquals(List.of("ep-2"), index.entries().stream().map(IndexEntry::slug).toList());
    }

    @Test
    void indexCarriesTheFavouriteTallyItAlreadyComputed() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("worth marking"));
        ctx.store().asUser(UUID.randomUUID()).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(UUID.randomUUID()).put(Scope.user(), "fav:ep-1", true);

        plugin.register(ctx);

        HighlightIndex index = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow();
        assertEquals(2, index.entries().get(0).favourites());
    }

    @Test
    void indexIsBackendOwnedLikeTheStatsBesideIt() {
        // Same reasoning as `stats`: a shared-scope document has no owner, so anything above the write
        // floor could otherwise replace a derived listing with one of its own choosing.
        FakePluginContext ctx = contextEnforcingBackendOwnedKeys("ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("something"));

        plugin.register(ctx);

        assertTrue(ctx.store().get(Scope.site(), "index", HighlightIndex.class).isPresent());
    }

    // PageRouteProvider (SDK 0.9.1, ARCHITECTURE §6.6). Every subpath under /p/sample/ used to answer 200,
    // so a typo and a deleted highlight were indistinguishable from a real page to a crawler. These run
    // through PageRouteProviderHarness, which probes the root whether a test lists it or not — the failure
    // it exists to catch is a provider written as a lookup over its own content, which 404s its own landing
    // page.

    @Test
    void servesItsOwnEntrancesAndTheHighlightsThatExist() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("written"));
        // ep-2 deliberately has no highlight: an episode that exists is still not a page here.
        plugin.register(ctx);

        var routes = new PageRouteProviderHarness(plugin)
                .check("moments", "gallery", "unwritten", "highlight/ep-1", "highlight/ep-2", "highlight/typo",
                        "highlight/", "nonsense", "moments/3");

        assertTrue(routes.servesRoot(), "the plugin's own landing page must not 404");
        assertEquals(List.of("", "moments", "gallery", "unwritten", "highlight/ep-1"), routes.served());
        assertEquals(
                List.of("highlight/ep-2", "highlight/typo", "highlight/", "nonsense", "moments/3"),
                routes.notFound());
        assertTrue(routes.failures().isEmpty(), "a provider that throws makes the host answer 200 anyway");
    }

    @Test
    void doesNotReuseShareMetadataToDecideWhetherARouteExists() {
        // The tempting shortcut, and the reason PageRouteProvider is a separate interface: metaFor() answers
        // empty for moments/gallery/unwritten *on purpose* — they have nothing to tell a link scraper — so
        // reading "no share metadata" as "no page" would 404 three working entrances out of nav[].
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        plugin.register(ctx);

        for (String entrance : List.of("moments", "gallery", "unwritten")) {
            assertEquals(Optional.empty(), plugin.metaFor(entrance));
            assertTrue(plugin.hasRoute(entrance), entrance + " must stay a real page");
        }
    }

    @Test
    void keepsAnsweringTwoHundredForItsHighlightsBeforeRegisterHasRun() {
        // Core resolves extension points independently of register(). Guessing 404 from a plugin that has
        // not finished starting would hide real pages, and the fixed entrances are answerable regardless.

        assertTrue(plugin.hasRoute(""));
        assertTrue(plugin.hasRoute("highlight/ep-1"));
        assertFalse(plugin.hasRoute("nonsense"));
        assertFalse(plugin.hasRoute(null));
    }

    // SearchProvider (SDK 0.9.0, ARCHITECTURE §6.7). SearchProviderHarness calls the provider once per role
    // *including anonymous*, which arrives as a null Role rather than a fourth enum constant — the mistake
    // an author writes by hand, and the one test this interface's unusual access rule demands.

    private static FakePluginContext contextForSearch() {
        FakeFeedAccess feeds = released("the-kraken", "the-lighthouse")
                .withDisplay("the-kraken",
                        new DisplaySnapshot("The Kraken", "notes", null, null, null, null, null, null, null, ""))
                .withDisplay("the-lighthouse",
                        new DisplaySnapshot("The Lighthouse", "notes", null, null, null, null, null, null, null, ""));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers();
        ctx.store().put(Scope.episode("the-kraken"), "highlight", new Highlight("the **squid** finally shows up"));
        return ctx;
    }

    @Test
    void contributesHighlightsToTheSiteSearchWithTitlesFromTheFeed() {
        FakePluginContext ctx = contextForSearch();
        plugin.register(ctx);

        var results = new SearchProviderHarness(plugin).search("squid");

        // Highlights are `data.readableBy: anonymous`, so this half is the same for everyone — anonymous
        // included, which is what forRole(null) checks.
        for (Role role : List.of(Role.ADMIN, Role.PODCASTER, Role.FAN)) {
            assertEquals(List.of("The Kraken"), results.titles(role));
        }
        assertEquals(List.of("The Kraken"), results.titles(null));

        SearchHit hit = results.forRole(null).get(0);
        // A bare subpath: the host resolves it under /p/<pluginId>/ and drops any attempt to climb out, so a
        // plugin neither builds that prefix nor could point a result at a core route.
        assertEquals("highlight/the-kraken", hit.subpath());
        assertTrue(hit.snippet().contains("squid"));
        assertFalse(hit.snippet().contains("*"), "the snippet is plain text, like the excerpt behind it");
        // The title is read live rather than cached into `index`: a display snapshot is overwritten on every
        // feed refetch (§4.2), so a copy beside the excerpt would be a second, staler answer.
        assertEquals("The Kraken", hit.title());
    }

    @Test
    void offersTheUnwrittenViewToAPodcasterAndNeverToAnonymous() {
        FakePluginContext ctx = contextForSearch();
        plugin.register(ctx);

        // "lighthouse" matches an episode with no highlight — nothing for a visitor, a to-do for a podcaster.
        var results = new SearchProviderHarness(plugin).search("lighthouse");

        assertEquals(List.of("Highlights to write"), results.titles(Role.PODCASTER));
        assertEquals(List.of("Highlights to write"), results.titles(Role.ADMIN));
        assertEquals(List.of(), results.titles(Role.FAN));
        assertEquals(List.of(), results.titles(null));
        // The regression this interface's access rule exists for: a provider returning something the caller
        // may not see has leaked it, and nothing else in the contract catches that.
        assertFalse(results.leakedToAnonymous("unwritten"));
    }

    @Test
    void searchDegradesToNothingRatherThanThrowing() {
        // Runs on a request with a budget (§6.7): a section that fails comes back marked, which reads to a
        // visitor as "this site does not have it". Cheap, bounded, and never a reason to throw.
        assertEquals(List.of(), plugin.search("anything", null, 10));

        FakePluginContext ctx = contextForSearch();
        plugin.register(ctx);

        assertEquals(List.of(), plugin.search("   ", Role.ADMIN, 10));
        assertEquals(List.of(), plugin.search("squid", Role.ADMIN, 0));
        assertEquals(List.of(), plugin.search("nothing-matches-this", Role.ADMIN, 10));
    }

    // UserDataHandler (SDK 0.9.0, ARCHITECTURE §12.8). Core drops the USER-scope marks itself; what it
    // cannot do is repair the three published documents that counted them.

    @Test
    void republishesFavouriteCountsWithoutADepartingAccountsMarks() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("worth marking"));
        UUID leaving = UUID.randomUUID();
        UUID staying = UUID.randomUUID();
        ctx.store().asUser(leaving).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(staying).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(leaving).put(Scope.user(), "fav:ep-2", true);
        plugin.register(ctx);
        assertEquals(Optional.of(new FavouriteCount(2)),
                ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));

        // Handlers run BEFORE core drops the account row, so the marks are still there to be filtered out —
        // which is why this excludes a user rather than simply re-tallying what is left.
        plugin.eraseUser(leaving.toString());

        assertEquals(Optional.of(new FavouriteCount(1)),
                ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class),
                "the remaining visitor's mark must survive");
        assertEquals(Optional.empty(), ctx.store().get(Scope.episode("ep-2"), "favourites", FavouriteCount.class),
                "an episode only the departing account marked drops its count entirely");
        // All three documents that embed the number are repaired, which is why this is one recompute rather
        // than three patches that could disagree.
        assertEquals(Optional.of(new HighlightStats(2, 1, 0, 1, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
        HighlightIndex index = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow();
        assertEquals(1, index.entries().get(0).favourites());
    }

    @Test
    void erasureIsIdempotentBecauseAFailedOneIsRetried() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        UUID leaving = UUID.randomUUID();
        UUID staying = UUID.randomUUID();
        ctx.store().asUser(leaving).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(staying).put(Scope.user(), "fav:ep-1", true);
        plugin.register(ctx);

        // The harness calls eraseUser twice and fails the test if the second throws. The subtler failure it
        // does not catch is a handler that *decrements*: that one succeeds twice and is wrong the second
        // time, so assert the answer too.
        new UserDataHandlerHarness(plugin).eraseTwice(leaving.toString());

        assertEquals(Optional.of(new FavouriteCount(1)),
                ctx.store().get(Scope.episode("ep-1"), "favourites", FavouriteCount.class));
    }

    @Test
    void refusesToReportSuccessWhenItCannotErase() {
        // §12.8: the host writes a row per plugin before it asks and leaves an open record on a failure,
        // then retries and surfaces it in admin. Swallowing this to report success is how data survives a
        // deletion nobody notices.
        assertThrows(IllegalStateException.class, () -> plugin.eraseUser(UUID.randomUUID().toString()));
    }

    @Test
    void exportsTheEpisodesAVisitorMarkedWithTitlesCoreCouldNotSupply() {
        FakeFeedAccess feeds = released("the-kraken")
                .withDisplay("the-kraken",
                        new DisplaySnapshot("The Kraken", "notes", null, null, null, null, null, null, null, ""));
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers();
        UUID visitor = UUID.randomUUID();
        UUID somebodyElse = UUID.randomUUID();
        ctx.store().asUser(visitor).put(Scope.user(), "fav:the-kraken", true);
        ctx.store().asUser(visitor).put(Scope.user(), "fav:ep-gone", true);   // episode left the feed
        ctx.store().asUser(visitor).put(Scope.user(), "fav:ep-2", false);     // withdrawn, not deleted
        ctx.store().asUser(somebodyElse).put(Scope.user(), "fav:the-kraken", true);
        plugin.register(ctx);

        Map<String, Object> export = new UserDataHandlerHarness(plugin)
                .export(visitor.toString())
                .orElseThrow();

        // Core can dump `fav:the-kraken → true` on its own; what it cannot do is know that `fav:` is this
        // plugin's key convention or that the rest of the key is an episode slug. The title is the half
        // worth overriding the defaulted method for.
        assertEquals(
                List.of(Map.of("episode", "the-kraken", "title", "The Kraken"), Map.of("episode", "ep-gone")),
                export.get("favouritedHighlights"));
    }

    @Test
    void landsInThePersonsArchiveAsDataJsonBecauseAListOfMarksHasNoFormatOfItsOwn() {
        // SDK 0.19.0 added exportFiles for data with a format of its own — a card a bingo import reads back, a
        // photo. A list of favourite marks has none, so this plugin keeps the Map form and the host writes it
        // as `plugins/sample/data.json`. Asked the way the host asks: exportFiles first, then exportUser.
        FakeFeedAccess feeds = released("the-kraken");
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null)
                .withReadsAllUsers();
        UUID visitor = UUID.randomUUID();
        ctx.store().asUser(visitor).put(Scope.user(), "fav:the-kraken", true);
        plugin.register(ctx);

        UserExport part = new UserDataHandlerHarness(plugin).exportFiles(visitor.toString()).orElseThrow();

        assertEquals(List.of("data.json"), part.files().stream().map(ExportFile::path).toList());
        assertTrue(new String(part.files().get(0).bytes(), StandardCharsets.UTF_8).contains("the-kraken"));
        assertEquals(Optional.empty(), new UserDataHandlerHarness(plugin).exportFiles(UUID.randomUUID().toString()),
                "somebody who marked nothing has no part at all — not an empty file");
    }

    @Test
    void exportsNothingForAVisitorWhoMarkedNothing() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        plugin.register(ctx);

        assertEquals(Optional.empty(), plugin.exportUser(UUID.randomUUID().toString()));
    }

    // Tags (SDK 0.9.0, ARCHITECTURE §6.1.1). FakeTags refuses an episode write unless withEpisodeWrites()
    // grants it, exactly as the host refuses one without `tags.writesEpisodes` — so a plain FakeTags here is
    // itself the assertion that this plugin never reaches for a capability its manifest does not declare.

    private static FakePluginContext contextWithTags(FakeTags tags, String... episodeIds) {
        FakeFeedAccess feeds = released(episodeIds);
        return new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers().withTags(tags);
    }

    @Test
    void mirrorsAnEpisodesTagsOntoItsOwnHighlightSubject() {
        FakeTags tags = new FakeTags().withFeedTag("ep-1", "Maritime").withFeedTag("ep-1", "  maritime ");
        FakePluginContext ctx = contextWithTags(tags, "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("about a lighthouse"));

        plugin.register(ctx);

        // The host owns the canonical key (trim, collapse whitespace, casefold) and keeps the label from
        // first use — so the two spellings above are one tag, and the plugin never canonicalises anything.
        assertEquals(List.of("maritime"), tags.tagsOnSubject("highlight:ep-1"));
        assertEquals(List.of("highlight:ep-1"), tags.subjectsWith("Maritime"));
        assertEquals("Maritime", tags.all().get(0).label(), "the label is presentation, kept from first use");
    }

    @Test
    void retiresASubjectTagWhenTheFeedDropsItOrTheHighlightGoesAway() {
        FakeTags tags = new FakeTags().withFeedTag("ep-1", "kraken");
        FakePluginContext ctx = contextWithTags(tags, "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("about a squid"));
        plugin.register(ctx);
        assertEquals(List.of("kraken"), tags.tagsOnSubject("highlight:ep-1"));

        // Removing this plugin's own assignment from its own subject is allowed; §6.1.1 forbids removing
        // *another writer's*, and nobody else writes here. Contrast untagEpisode, which this plugin cannot
        // call at all — FakeTags would throw, and so would the host.
        ctx.store().delete(Scope.episode("ep-1"), "highlight");
        plugin.register(ctx);

        assertEquals(List.of(), tags.tagsOnSubject("highlight:ep-1"));
        assertEquals(List.of("ep-1"), tags.episodesWith("kraken"), "the feed's own assignment is untouched");
    }

    @Test
    void runsUnchangedOnAnInstallWithNoTagSurface() {
        // ctx.tags() is null when the manifest declares no `tags` block, or an operator withheld it. Same
        // posture as ctx.blobs(): the recompute pass must still complete rather than NPE.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("still fine"));

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(1, 1, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    // ---------------------------------------------------------------------------------------------
    // Languages and machine translation (SDK 0.10.0/0.11.0)
    // ---------------------------------------------------------------------------------------------

    /** A bilingual site: content may be authored in English (the default) or German. */
    private static FakePluginContext bilingual(String... episodeIds) {
        return contextWithEpisodes(new MapPluginConfig(), episodeIds)
                .withLocales(FakeLocales.englishOnly().withUi("de"));
    }

    @Test
    void countsAHighlightAsFullyTranslatedOnlyWhenEveryContentLanguageIsWritten() {
        FakePluginContext ctx = bilingual("ep-1", "ep-2");
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("the keeper"));

        plugin.register(ctx);

        assertEquals(
                Optional.of(new HighlightStats(2, 2, 0, 0, 1, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void reportsNothingAsFullyTranslatedOnASingleLanguageSite() {
        // The empty-list guard, pinned. `containsAll(emptyList)` is true for every episode, so without it
        // this reads "every highlight is translated into every language" — accurate, and a claim about
        // something that does not exist. Zero is the honest answer where there is nothing to translate into.
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid"));

        plugin.register(ctx);

        assertEquals(0, ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow().fullyTranslated());
    }

    @Test
    void countsButNeverDeletesTextStoredUnderALocaleTheSiteDoesNotAuthorIn() {
        // **The keys inside `translations` are client input.** They sit inside a JSON value, so the host's
        // doc-key pattern never sees them and nothing validated them on the way in — `isContentLocale` is
        // the check the SDK puts on the backend for exactly this reason.
        FakePluginContext ctx = bilingual("ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", Map.of(
                "markdown", "the squid",
                "translations", Map.of(
                        "de", Map.of("markdown", "der Tintenfisch"),
                        "kl", Map.of("markdown", "forged"))));

        plugin.register(ctx);

        HighlightStats stats = ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow();
        assertEquals(1, stats.strandedTranslations());
        // Reported, **not deleted**, and the restraint is the point: this code cannot tell a forged key from
        // a language an admin disabled after a podcaster legitimately wrote prose in it. Deleting covers the
        // first and destroys somebody's work in the second — and the first is already harmless, because the
        // frontend only ever looks up a locale the host handed it.
        assertTrue(ctx.store().get(Scope.episode("ep-1"), "highlight", Map.class).orElseThrow()
                .toString().contains("forged"));
        // Two, not one: `register()` recomputes eagerly and the testkit then fires the schedule
        // synchronously, so an operator sees the warning once per pass — which is the intent. A stranded
        // locale is a standing condition, not an event, and it should keep saying so until somebody acts.
        assertEquals(2, ctx.logger().events(Level.WARN).size());
    }

    @Test
    void draftsTheMissingLanguagesIntoADocumentOnlyTheEditorReads() {
        FakePluginContext ctx = bilingual("ep-1").withTranslation(FakeTranslation.marking());
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid shows up"));

        plugin.register(ctx);

        // Into `drafts`, never into `highlight.translations`. A scheduled job that wrote the second would
        // publish machine prose to every reader of that language with no human anywhere in the loop.
        TranslationDrafts drafts =
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.DRAFTS_KEY, TranslationDrafts.class).orElseThrow();
        assertEquals(1, drafts.drafts().size());
        assertEquals("de", drafts.drafts().get(0).locale());
        assertEquals("[de] the squid shows up", drafts.drafts().get(0).markdown());
        assertEquals("the squid shows up".hashCode(), drafts.drafts().get(0).sourceHash());
        // Empty, not merely "not the draft": the fixture wrote the doc through the Highlight record, whose
        // `translations` component serialises as {} — in production the frontend writes this document and the
        // backend never touches it at all.
        assertTrue(((Map<?, ?>) ctx.store().get(Scope.episode("ep-1"), "highlight", Map.class).orElseThrow()
                .getOrDefault("translations", Map.of())).isEmpty());
    }

    @Test
    void neverDraftsALanguageThePodcasterHasAlreadyWritten() {
        FakeTranslation translation = FakeTranslation.marking();
        FakePluginContext ctx = bilingual("ep-1").withTranslation(translation);
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        // Not one call. Every draft is money on somebody else's metered API, and there is nothing here to do.
        assertEquals(List.of(), translation.requests());
    }

    @Test
    void makesNoCallAtAllWhenTheManifestOrTheOperatorWithheldTranslation() {
        // `ctx.translation()` is null for two deliberately indistinguishable reasons — no `external.kinds`
        // declaration, or no provider selected — and the second is every site by default. The pass must
        // still complete: translation is an enhancement on a recompute that has four other jobs to do.
        FakePluginContext ctx = bilingual("ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid"));

        plugin.register(ctx);

        assertEquals(Optional.empty(),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.DRAFTS_KEY, TranslationDrafts.class));
        assertEquals(Optional.of(new HighlightStats(1, 1, 0, 0, 0, 0)),
                ctx.store().get(Scope.site(), "stats", HighlightStats.class));
    }

    @Test
    void skipsDraftingWhenTheProviderIsUnavailableWithoutTouchingIt() {
        // `available()` is the cheap check that avoids a call nobody expects to succeed. It is advisory, so
        // the exception path below still has to exist — but a pass that ignored it would spend a request per
        // episode discovering the same thing.
        FakeTranslation translation = FakeTranslation.marking().unavailable();
        FakePluginContext ctx = bilingual("ep-1").withTranslation(translation);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid"));

        plugin.register(ctx);

        assertEquals(List.of(), translation.requests());
    }

    @Test
    void stopsTheWholePassOnARetryableRefusal() {
        // `retryable()`, not the message: a rate limit does not become untrue for the next episode, and
        // hammering it is how a soft limit becomes a hard one. Matching on English wording instead is how a
        // plugin breaks the day the host rewords a log line — which is why `reason()` is an enum.
        FakeTranslation translation = FakeTranslation.failing(TranslationException.Reason.RATE_LIMITED);
        FakePluginContext ctx = bilingual("ep-1", "ep-2", "ep-3").withTranslation(translation);
        for (String id : List.of("ep-1", "ep-2", "ep-3")) {
            ctx.store().put(Scope.episode(id), "highlight", new Highlight("the squid"));
        }

        plugin.register(ctx);

        // One call, then the pass gives up — not one per episode. `register()` runs the recompute twice
        // (eagerly, then the testkit fires the schedule synchronously), so this is one attempt per pass.
        assertEquals(2, translation.requests().size());
    }

    @Test
    void keepsGoingPastANonRetryableRefusal() {
        // MISCONFIGURED is a fact about one provider setting, not about the site's budget, and the next
        // locale may well be one the provider does support. Giving up on the whole pass would be the
        // conservative-looking choice that quietly stops drafting anything at all.
        FakeTranslation translation = FakeTranslation.failing(TranslationException.Reason.MISCONFIGURED);
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1")
                .withLocales(FakeLocales.englishOnly().withUi("de", "nl"))
                .withTranslation(translation);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid"));

        plugin.register(ctx);

        // Both languages attempted, and nothing written.
        assertEquals(List.of("de", "nl"), translation.requests().stream().map(r -> r.to()).distinct().toList());
        assertEquals(Optional.empty(),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.DRAFTS_KEY, TranslationDrafts.class));
    }

    // ---------------------------------------------------------------------------------------------
    // Who wrote it (SDK 0.13.0, ctx.users, ARCHITECTURE §8.8)
    // ---------------------------------------------------------------------------------------------

    /** One episode with a feed snapshot, which {@code metaFor} needs for its title and artwork. */
    private static FakePluginContext contextWithDisplay(String episodeId) {
        FakeFeedAccess feeds = released(episodeId)
                .withDisplay(episodeId,
                        new DisplaySnapshot("The Kraken", null, null, null, null, null, null, null, null, ""));
        return new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null).withReadsAllUsers();
    }

    @Test
    void putsTheAuthorsCurrentNameInTheOpenGraphDescriptionRatherThanAStoredCopy() {
        FakeUsers users = new FakeUsers();
        UUID ana = users.withUser("Ana Ruiz", Role.PODCASTER);
        FakePluginContext ctx = contextWithDisplay("ep-1").withUsers(users);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid shows up", ana.toString()));

        plugin.register(ctx);

        OgMeta meta = plugin.metaFor("highlight/ep-1").orElseThrow();
        assertTrue(meta.description().endsWith("— Ana Ruiz"), meta.description());
        // The name was never stored. What is in the document is the UUID, which is why a rename shows up on
        // the next scrape rather than the next time somebody edits the highlight.
        assertEquals(List.of(ana), users.resolvedIds());
    }

    @Test
    void leavesTheHighlightStandingWhenItsAuthorHasBeenErased() {
        // `resolve` **omits** an unknown, erased or pseudonymised id rather than returning a tombstone for
        // it (§12.8), so the result is not index-aligned with what was asked and may be shorter. The
        // highlight outlives its author: description without a byline, no exception, no empty dash.
        FakeUsers users = new FakeUsers();
        UUID ana = users.withUser("Ana Ruiz", Role.PODCASTER);
        users.withoutUser(ana);
        FakePluginContext ctx = contextWithDisplay("ep-1").withUsers(users);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid shows up", ana.toString()));

        plugin.register(ctx);

        assertEquals("the squid shows up", plugin.metaFor("highlight/ep-1").orElseThrow().description());
    }

    @Test
    void carriesTheAuthorIdIntoTheListingSoThePageCanResolveItInOneCall() {
        FakePluginContext ctx = contextWithEpisodes(new MapPluginConfig(), "ep-1", "ep-2");
        UUID ana = UUID.randomUUID();
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid", ana.toString()));
        // ep-2's highlight predates 2.15.0 and has no authorId at all — the ordinary case for a while.
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("the keeper"));

        plugin.register(ctx);

        List<IndexEntry> entries = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow().entries();
        assertEquals(ana.toString(), entries.stream().filter(e -> e.slug().equals("ep-1")).findFirst()
                .orElseThrow().authorId());
        assertNull(entries.stream().filter(e -> e.slug().equals("ep-2")).findFirst().orElseThrow().authorId());
    }

    @Test
    void ignoresAnAuthorIdThatIsNotAUuidRatherThanFailingThePage() {
        // `authorId` lives in a shared-scope document, which has no owner: anything above `data.writableBy`
        // could PUT any string here. It is a byline and nothing is decided on it, so a malformed one costs
        // a reader a byline and nothing else.
        FakeUsers users = new FakeUsers();
        FakePluginContext ctx = contextWithDisplay("ep-1").withUsers(users);
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the squid", "not-a-uuid"));

        plugin.register(ctx);

        assertEquals("the squid", plugin.metaFor("highlight/ep-1").orElseThrow().description());
        assertEquals(List.of(), users.resolvedIds());
    }

    @Test
    void asksNobodyWhenTheManifestDeclaresNoIdentityBlock() {
        // `ctx.users()` is null without an `identity` block, the same shape `blobs`, `tags` and
        // `translation` have. A fork of this plugin that drops the block keeps working, minus the byline.
        FakePluginContext ctx = contextWithDisplay("ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                new Highlight("the squid", UUID.randomUUID().toString()));

        plugin.register(ctx);

        assertEquals("the squid", plugin.metaFor("highlight/ep-1").orElseThrow().description());
    }

    // ---------------------------------------------------------------------------------------------
    // Telling a listener their highlight speaks their language (SDK 0.14.0, ctx.notifier, §17)
    // ---------------------------------------------------------------------------------------------

    /**
     * A bilingual site with a notifier, and one user who favourited {@code ep-1}.
     *
     * <p>{@link FakeNotifier} reads eligibility from the {@link InMemoryDocStore}'s own user partitions, so
     * the act that makes somebody notifiable is the act that made them a favouriter — the rule cannot drift
     * from the host's, which checks the same partitions.
     */
    private static FakePluginContext announcing(FakeNotifier[] out, UUID favouriter, String... episodeIds) {
        FakePluginContext ctx = bilingual(episodeIds);
        ctx.store().asUser(favouriter).put(Scope.user(), "fav:" + episodeIds[0], true);
        FakeNotifier notifier = new FakeNotifier(ctx.store());
        out[0] = notifier;
        return ctx.withNotifier(notifier);
    }

    @Test
    void seedsWhatAnEpisodeAlreadyHasInsteadOfAnnouncingAllOfItAtOnce() {
        // The migration case, and the one worth a test of its own: treating an absent record as "nothing
        // announced yet" would fire one notification per existing translation at every existing favouriter
        // the moment this version is installed.
        FakeNotifier[] out = new FakeNotifier[1];
        FakePluginContext ctx = announcing(out, UUID.randomUUID(), "ep-1");
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        assertEquals(List.of(), out[0].delivered());
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    @Test
    void tellsEveryFavouriterWhenAHighlightGainsALanguage() {
        FakeNotifier[] out = new FakeNotifier[1];
        UUID ana = UUID.randomUUID();
        FakePluginContext ctx = announcing(out, ana, "ep-1");
        // Already seeded with nothing: the episode has been seen before and had no translations then.
        ctx.store().put(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, new AnnouncedLocales(Set.of()));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        List<NotifyMessage> got = out[0].messagesFor(ana);
        assertEquals(1, got.size(), "one announcement, not one per recompute pass");
        // Every language up front, because the reader's is not knowable here — there is no read side, and a
        // notification written on a timer is read days later in whatever language the shell is set to then.
        // And the *new language* is named in the language of the sentence it sits in: "German" to an English
        // reader, "Deutsch" to a German one. Naming every language by its endonym produced "now available in
        // Deutsch" in the English text, which is a bug a unit test can catch and a live run found first.
        assertTrue(got.get(0).textFor("en").contains("German"), got.get(0).textFor("en"));
        assertFalse(got.get(0).textFor("en").contains("Deutsch"), got.get(0).textFor("en"));
        assertTrue(got.get(0).textFor("de").startsWith("Das Highlight"), got.get(0).textFor("de"));
        assertTrue(got.get(0).textFor("de").contains("Deutsch"), got.get(0).textFor("de"));
        // The link is a subpath of this plugin's own subtree — one of the two shapes the host will point a
        // notification at. Anything off-site is refused, and rightly.
        assertEquals("highlight/ep-1", got.get(0).link());
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    @Test
    void countsWhoWasActuallyReachedRatherThanWhoWasAskedFor() {
        // `send` answers the ids it notified, not `void`, because the host's eligibility rule guarantees
        // partial sends: a favouriter erased since the mark was written is the ordinary case. One stale
        // participant must not cost the others their notification, and the difference must not be silent.
        FakeNotifier[] out = new FakeNotifier[1];
        UUID ana = UUID.randomUUID();
        FakePluginContext ctx = announcing(out, ana, "ep-1");
        // A second favouriter whose account is gone: a mark in the tally, no partition left to deliver to.
        UUID ghost = UUID.randomUUID();
        ctx.store().asUser(ghost).put(Scope.user(), "fav:ep-1", true);
        ctx.store().asUser(ghost).delete(Scope.user(), "fav:ep-1");
        ctx.store().put(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, new AnnouncedLocales(Set.of()));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        assertEquals(List.of(ana), out[0].delivered().stream().map(FakeNotifier.Delivery::userId).toList());
        // Recorded anyway: the announcement happened, and re-running it would not resurrect the ghost.
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    @Test
    void holdsTheAnnouncementForALaterTickWhenTheOperatorsCapIsExhausted() {
        // RATE_LIMITED is retryable(), so the record is **not** advanced — the next tick tries the same
        // episode again. Advancing it would drop an announcement on the floor because the site was busy.
        // A cap of one and two episodes is the real shape: the first send spends it and the second is
        // refused, which is exactly what a backlog draining against an operator's limit looks like.
        FakeNotifier[] out = new FakeNotifier[1];
        UUID ana = UUID.randomUUID();
        FakePluginContext ctx = announcing(out, ana, "ep-1", "ep-2");
        ctx.store().asUser(ana).put(Scope.user(), "fav:ep-2", true);
        out[0].withPerUserPerDay(1);
        for (String id : List.of("ep-1", "ep-2")) {
            ctx.store().put(Scope.episode(id), SamplePlugin.ANNOUNCED_KEY, new AnnouncedLocales(Set.of()));
            ctx.store().put(Scope.episode(id), "highlight",
                    Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));
        }

        plugin.register(ctx);

        // One delivery, for the episode that got in under the cap.
        assertEquals(1, out[0].delivered().size());
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
        // The refused one keeps its place: still nothing announced, so a later tick will try again.
        assertEquals(Optional.of(new AnnouncedLocales(Set.of())),
                ctx.store().get(Scope.episode("ep-2"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
        assertTrue(ctx.logger().events(Level.WARN).stream()
                .anyMatch(e -> e.message().contains("RATE_LIMITED")), ctx.logger().events(Level.WARN).toString());
    }

    @Test
    void neverAnnouncesTheSameLanguageTwice() {
        FakeNotifier[] out = new FakeNotifier[1];
        UUID ana = UUID.randomUUID();
        FakePluginContext ctx = announcing(out, ana, "ep-1");
        ctx.store().put(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, new AnnouncedLocales(Set.of("de")));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        assertEquals(List.of(), out[0].delivered());
    }

    @Test
    void tellsNobodyAboutAHighlightNobodyFavourited() {
        // Eligibility is the host's and is satisfied by construction here — a favouriter has a USER-scope
        // row, which is the same partition the host checks. With no favouriters there is nobody this plugin
        // is permitted to reach, and it does not try.
        FakePluginContext ctx = bilingual("ep-1");
        FakeNotifier notifier = new FakeNotifier(ctx.store());
        ctx = ctx.withNotifier(notifier);
        ctx.store().put(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, new AnnouncedLocales(Set.of()));
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        assertEquals(List.of(), notifier.delivered());
        // The record still advances: the language is not news any more once the pass has seen it, and
        // leaving it out would announce it to whoever favourites the highlight tomorrow.
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    @Test
    void writesNoBookkeepingAtAllWhenTheManifestDeclaresNoNotificationsBlock() {
        // `ctx.notifier()` is null without the block. Nothing is stored either — a plugin that cannot
        // announce has nothing to remember about announcements.
        FakePluginContext ctx = bilingual("ep-1");
        ctx.store().asUser(UUID.randomUUID()).put(Scope.user(), "fav:ep-1", true);
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));

        plugin.register(ctx);

        assertEquals(Optional.empty(),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    // ---- Quiet planned episodes (SDK 0.18.0, core 0.7.7) ------------------------------------------------

    /** ep-1 released, ep-2 planned and not announced; both with a highlight. */
    private FakePluginContext oneQuietOneReleased() {
        FakeFeedAccess feeds = released("ep-1", "ep-2").withPhase("ep-2", EpisodePhase.PLANNED);
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null)
                .withReadsAllUsers();
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the lighthouse"));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("the secret one"));
        return ctx;
    }

    @Test
    void publishesNothingThatNamesAQuietPlannedEpisode() {
        // A backend sees a planned episode before anyone else does — that is when a highlight gets prepared —
        // and everything below is readable by an anonymous visitor. Each would name an episode the site is
        // still hiding, with its title and the podcaster's prose attached.
        FakePluginContext ctx = oneQuietOneReleased();

        plugin.register(ctx);

        HighlightIndex index = ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow();
        assertEquals(List.of("ep-1"), index.entries().stream().map(IndexEntry::slug).toList());
        HighlightStats stats = ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow();
        assertEquals(1, stats.totalEpisodes(), "the count would give the planned episode away too");
        assertEquals(1, stats.highlightedEpisodes());
        assertEquals(List.of(new SitemapUrl("/p/sample/highlight/ep-1", null)), plugin.urls());
        assertEquals(Optional.empty(), plugin.metaFor("highlight/ep-2"));
        assertFalse(plugin.hasRoute("highlight/ep-2"), "a real 404, not a page that says nothing is there");
        assertEquals(List.of(), plugin.search("secret", null, 10));
        // Prepared, not lost: the highlight itself is untouched for the podcaster to keep working on.
        assertTrue(ctx.store().get(Scope.episode("ep-2"), "highlight", Highlight.class).isPresent());
    }

    @Test
    void anAnnouncedEpisodeIsPublicBeforeItIsReleased() {
        // UPCOMING is everyone's "coming soon" card: hiding its highlight would be the opposite mistake.
        FakePluginContext ctx = oneQuietOneReleased();
        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.UPCOMING);

        plugin.register(ctx);

        assertEquals(List.of("ep-1", "ep-2"), ctx.store().get(Scope.site(), "index", HighlightIndex.class)
                .orElseThrow().entries().stream().map(IndexEntry::slug).toList());
        assertTrue(plugin.hasRoute("highlight/ep-2"));
    }

    @Test
    void checksThePhasePerRequestBecauseItMovesWithNothingWritten() {
        // The index is as old as the last pass. A podcaster moving an announcement later puts an UPCOMING
        // episode back into PLANNED without a write anywhere — the per-request surfaces must notice at once.
        FakePluginContext ctx = oneQuietOneReleased();
        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.UPCOMING);
        plugin.register(ctx);

        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.PLANNED);

        assertFalse(plugin.hasRoute("highlight/ep-2"));
        assertEquals(List.of(new SitemapUrl("/p/sample/highlight/ep-1", null)), plugin.urls());
        assertEquals(List.of(), plugin.search("secret", null, 10), "the stale index entry must not surface");
    }

    @Test
    void listsAPreparedHighlightAsSoonAsItsEpisodeIsReleased() {
        FakePluginContext ctx = oneQuietOneReleased();
        plugin.register(ctx);
        // One hook (SDK 0.19.0): a release reaches the phase listener as RELEASED, so a release listener as
        // well would only recompute the same answer twice.
        assertEquals(1, ctx.episodePhaseListenerCount());
        assertEquals(0, ctx.episodeReleasedListenerCount());

        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.RELEASED);
        ctx.fireEpisodePhaseChanged("ep-2", EpisodePhase.RELEASED);

        // Not an interval later: the hook recomputes. The schedule would get there too, which is what makes
        // the hook — best effort by contract — safe to rely on as a shortcut only.
        assertEquals(List.of("ep-1", "ep-2"), ctx.store().get(Scope.site(), "index", HighlightIndex.class)
                .orElseThrow().entries().stream().map(IndexEntry::slug).toList());
    }

    @Test
    void announcesNothingWrittenWhileAnEpisodeWasQuiet() {
        // Translations written while preparing are part of what the episode has on release, not news about
        // it: the first public pass seeds `announced` and tells nobody.
        FakeNotifier[] out = new FakeNotifier[1];
        UUID ana = UUID.randomUUID();
        FakePluginContext ctx = announcing(out, ana, "ep-1");
        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-1", EpisodePhase.PLANNED);
        ctx.store().put(Scope.episode("ep-1"), "highlight",
                Map.of("markdown", "the squid", "translations", Map.of("de", Map.of("markdown", "der Tintenfisch"))));
        plugin.register(ctx);
        assertEquals(Optional.empty(),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));

        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-1", EpisodePhase.RELEASED);
        ctx.fireEpisodePhaseChanged("ep-1", EpisodePhase.RELEASED);

        assertEquals(List.of(), out[0].messagesFor(ana));
        assertEquals(Optional.of(new AnnouncedLocales(Set.of("de"))),
                ctx.store().get(Scope.episode("ep-1"), SamplePlugin.ANNOUNCED_KEY, AnnouncedLocales.class));
    }

    @Test
    void unlistsAnEpisodeTheMomentItGoesQuietAgain() {
        // SDK#98, closed by 0.19.0's phase hook. An announced episode whose announcement a podcaster moves
        // later is PLANNED again with nothing written to this plugin — and until 2.20.0 the public `index`
        // and `stats` docs kept naming it until the next scheduled pass.
        FakePluginContext ctx = oneQuietOneReleased();
        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.UPCOMING);
        plugin.register(ctx);
        assertEquals(List.of("ep-1", "ep-2"), indexedSlugs(ctx));

        ((FakeFeedAccess) ctx.feeds()).withPhase("ep-2", EpisodePhase.PLANNED);
        ctx.fireEpisodePhaseChanged("ep-2", EpisodePhase.PLANNED);

        assertEquals(List.of("ep-1"), indexedSlugs(ctx));
        assertEquals(1, ctx.store().get(Scope.site(), "stats", HighlightStats.class).orElseThrow().totalEpisodes());
    }

    @Test
    void dropsACancelledPlanFromTheListing() {
        // Cancelling deletes the episode and its episode-scoped docs; the site-scope listing is ours to fix.
        FeedAccessWithRemoval feeds = new FeedAccessWithRemoval("ep-1", "ep-2");
        FakePluginContext ctx = new FakePluginContext(new InMemoryDocStore(), new MapPluginConfig(), feeds, null)
                .withReadsAllUsers();
        ctx.store().put(Scope.episode("ep-1"), "highlight", new Highlight("the lighthouse"));
        ctx.store().put(Scope.episode("ep-2"), "highlight", new Highlight("announced, then cancelled"));
        plugin.register(ctx);
        assertEquals(List.of("ep-1", "ep-2"), indexedSlugs(ctx));

        feeds.remove("ep-2");
        ctx.store().delete(Scope.episode("ep-2"), "highlight");
        ctx.fireEpisodePhaseChanged("ep-2", null);

        assertEquals(List.of("ep-1"), indexedSlugs(ctx));
    }

    private static List<String> indexedSlugs(FakePluginContext ctx) {
        return ctx.store().get(Scope.site(), "index", HighlightIndex.class).orElseThrow()
                .entries().stream().map(IndexEntry::slug).toList();
    }

    /** A site whose episode list can lose one — what a cancelled plan is. {@link FakeFeedAccess}'s is fixed. */
    private static final class FeedAccessWithRemoval implements FeedAccess {
        private final List<String> slugs;

        FeedAccessWithRemoval(String... slugs) {
            this.slugs = new ArrayList<>(List.of(slugs));
        }

        void remove(String slug) {
            slugs.remove(slug);
        }

        @Override
        public List<String> episodesIn(Scope scope) {
            return List.copyOf(slugs);
        }

        @Override
        public DisplaySnapshot display(String refId) {
            if (!slugs.contains(refId)) {
                throw new IllegalArgumentException("no such episode: " + refId);
            }
            return new DisplaySnapshot(refId, null, null, null, null, null, null, null, null, "", null, null, null,
                    EpisodePhase.RELEASED, null);
        }
    }
}
