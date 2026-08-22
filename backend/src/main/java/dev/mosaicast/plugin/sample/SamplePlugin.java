// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import dev.mosaicast.plugin.api.BlobInfo;
import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.DocEntry;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.OwnedDocEntry;
import dev.mosaicast.plugin.api.PluginBackend;
import dev.mosaicast.plugin.api.PluginContext;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.ShareMetadataProvider;
import dev.mosaicast.plugin.api.SitemapProvider;
import dev.mosaicast.plugin.api.SitemapUrl;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import org.pf4j.Extension;
import tools.jackson.databind.JsonNode;

/**
 * Reference {@link PluginBackend} implementation for the "Episode Highlight" sample: a podcaster-editable
 * markdown highlight at episode, feed and site scope, plus a podcaster-only site-sidebar settings panel.
 *
 * <p>Highlights and settings themselves are read and written entirely through the host's generic
 * doc-store HTTP surface — this class never sees an individual read/write. Its jobs are the things that
 * surface cannot do:
 * <ul>
 *   <li><strong>Own the keys it computes</strong> (SDK 0.6.0): {@code stats} and {@code favourites} below are
 *       written by this class and by nothing else, so {@code plugin.json} lists them in
 *       {@code data.backendOwned}. Without that declaration a shared-scope document has no owner at all —
 *       authorization on the host's data surface is per <em>plugin</em>, not per document, so any caller
 *       above the manifest's {@code writableBy} floor could {@code PUT} a forged {@code stats} over HTTP and
 *       have it served to every visitor. The floors were never wrong; there was simply no way to say "this
 *       key is the backend's". {@link PluginContext#store()} is unaffected — the backend keeps writing, which
 *       is the point. The client-written keys ({@code highlight}, {@code settings}, and every {@code fav:}
 *       mark) are deliberately <em>not</em> declared.
 *   <li><strong>Aggregate</strong> across scopes: {@link #register(PluginContext)} schedules a recurring
 *       recount of how many site episodes currently have a highlight, using {@link PluginContext#feeds()}
 *       + {@link PluginContext#store()}, storing the result at {@code Scope.site()}/{@code "stats"} for
 *       the site-scope Web Component to display. The same pass <strong>prunes</strong> contentless
 *       highlight docs via {@link dev.mosaicast.plugin.api.DocStore#delete(Scope, String)} — the one
 *       housekeeping job no per-request code path can do.
 *   <li><strong>Aggregate across users</strong> (SDK 0.5.0): the same pass tallies every visitor's
 *       {@code fav:<episodeSlug>} mark out of their own {@link dev.mosaicast.plugin.api.ScopeType#USER}
 *       partition via {@link dev.mosaicast.plugin.api.DocStore#queryAcrossUsers(String)} and publishes a
 *       per-episode count to an episode scope the frontend may read. This is the only way that number can
 *       be assembled at all — per-user documents live at {@code data/user/me/…}, which resolves to the
 *       <em>caller's</em> partition, so no browser can count anybody but itself. It is also the only way
 *       the number is <em>true</em>: the owner id on each {@link dev.mosaicast.plugin.api.OwnedDocEntry}
 *       is host-resolved from the partition the document sits in, never a value a client supplied.
 *   <li><strong>Collect orphaned uploads</strong> (SDK 0.8.0): the same scheduled pass deletes images no
 *       highlight points at any more via {@link PluginContext#blobs()} — see
 *       {@link #sweepOrphanedImages(PluginContext, Set)}. Nothing on this platform collects orphans, a blob
 *       outlives the document that named it, and only this plugin knows which those are. The frontend drops
 *       the ref it just stopped pointing at; this is the net under it, and being a backend job is not
 *       incidental — it is the only place a whole-store view exists.
 *   <li><strong>Serve deep links</strong> ({@code /p/sample/highlight/<episodeSlug>}, ARCHITECTURE §6.4):
 *       this class also implements the two optional extension points a plugin may add on top of {@link
 *       PluginBackend} — {@link ShareMetadataProvider} (OpenGraph tags for link scrapers) and {@link
 *       SitemapProvider} ({@code sitemap.xml} entries).
 * </ul>
 *
 * <p><strong>Confirmed live against a running core (ARCHITECTURE §6.4/§6.6 now implemented):</strong>
 * {@code GET /p/sample/highlight/<slug>} and {@code /sitemap.xml} really do call {@link #metaFor(String)}/
 * {@link #urls()} — but doing so surfaced a real PF4J gotcha this class had to be fixed for. Core's default
 * PF4J {@code ExtensionFactory} creates a <strong>separate instance</strong> of this class for every
 * extension-point type it looks up ({@code PluginBackend}, {@code ShareMetadataProvider},
 * {@code SitemapProvider} each get their own {@code new SamplePlugin()}), so a plain instance field set in
 * {@link #register(PluginContext)} is invisible to {@link #metaFor(String)}/{@link #urls()} — they run on a
 * <em>different</em> object whose field was never set, which threw a NullPointerException in practice.
 * PF4J does give every plugin its own classloader, so a {@code static} field — scoped to this class within
 * this plugin's classloader, not to any one instance — is shared correctly across all of PF4J's
 * instances of it. Hence {@link #ctx} below is {@code static}, not a plain field; see
 * {@code SamplePluginTest} for a regression test that instantiates a fresh {@code SamplePlugin} per method
 * call, exactly like PF4J does, which a same-instance test could never have caught. {@link #metaFor(String)}
 * and {@link #urls()} additionally treat a still-null {@link #ctx} as "nothing to contribute" rather than
 * dereferencing it: core looks extension points up independently of {@code register()}, so a lookup that
 * happens first must degrade to no OG tags / no sitemap entries, not throw.
 *
 * <p><strong>{@link PluginContext#schema()} is intentionally never called here.</strong> The manifest is the
 * one place a plugin says which store it uses, and {@code plugin.json} declares {@code "storage": "doc"}, so
 * {@code schema()} is {@code null} by contract. The doc store is the default and covers nearly everything,
 * which is why the reference plugin uses it; reaching {@code SchemaStore} would mean changing what this
 * plugin stores, not adding a call. {@link #recomputeHighlightStats(PluginContext)}
 * below uses {@link dev.mosaicast.plugin.api.DocStore#query(Scope, String)} instead, this plugin's one use
 * of the Jackson-3-shaped {@link JsonNode} the doc store hands back from a prefix scan.
 */
@Extension
public class SamplePlugin implements PluginBackend, ShareMetadataProvider, SitemapProvider {

    /** Fallback used when the podcaster has not configured {@code refreshIntervalMinutes}. */
    static final int DEFAULT_REFRESH_MINUTES = 30;

    /** The deep-link subpath prefix this plugin serves: {@code /p/sample/highlight/<episodeSlug>}. */
    private static final String HIGHLIGHT_SUBPATH_PREFIX = "highlight/";

    /**
     * Key prefix of a visitor's own "I liked this highlight" mark, written by the frontend to
     * {@code data/user/me/fav:<episodeSlug>}.
     *
     * <p>The episode is in the <em>key</em> and not in the scope because a {@code USER} partition is flat
     * — one per user, not one per user and episode. Note the direction: pre-0.5.0 the advice was the exact
     * opposite (an entity scope with the <em>user</em> in the key), which is what made per-user data
     * addressable, and forgeable, by any other caller.
     */
    private static final String FAVOURITE_KEY_PREFIX = "fav:";

    /** Doc key holding {@link FavouriteCount} at an episode scope. */
    private static final String FAVOURITE_COUNT_KEY = "favourites";

    /** Page size for walking this plugin's blobs during the orphan sweep; the host caps what it honours. */
    private static final int BLOB_SWEEP_PAGE_SIZE = 100;

    /** Longest excerpt of a highlight's markdown carried into {@link OgMeta#description()}. */
    private static final int DESCRIPTION_EXCERPT_LENGTH = 160;

    /** Markdown punctuation dropped by {@link #excerpt(String)}; precompiled — {@code urls()} runs per request. */
    private static final Pattern MARKDOWN_TOKENS = Pattern.compile("[#*_`\\[\\]()]");

    /** Collapses newlines/indentation into single spaces for a one-line OG description. */
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");

    /** Mirrors the frontend's stored highlight shape ({@code { markdown: string } }) at every scope. */
    record Highlight(String markdown) {
    }

    /**
     * Mirrors the frontend's {@code stats} doc shape, read at {@code data/site/main/stats}.
     *
     * <p>Written here only, and declared {@code data.backendOwned} so the host refuses a client write to it —
     * the forged {@code PUT} in the SDK's 0.6.0 migration guide is a forged {@code stats} on this plugin.
     */
    record HighlightStats(int totalEpisodes, int highlightedEpisodes, int episodesWithMoment, int totalFavourites) {
    }

    /**
     * How many distinct visitors have favourited an episode's highlight, published to
     * {@code data/episode/<slug>/favourites}.
     *
     * <p>A shared doc that is read-only over HTTP and derived from data the frontend cannot read: the marks
     * it counts are unreachable from any browser but their owner's, and {@code favourites} is declared
     * {@code data.backendOwned} (SDK 0.6.0), so a {@code PUT}/{@code DELETE} from any client is a 403 no
     * matter what role it holds. The {@code writableBy: podcaster} floor alone would not have been enough —
     * it would have let a podcaster publish any number they liked.
     */
    record FavouriteCount(int count) {
    }

    /**
     * One highlighted episode, as the plugin's own page lists it.
     *
     * @param slug           the episode's public slug, the only identifier a client ever sees
     * @param excerpt        a plain-text opening of the markdown, for a card; never the whole body
     * @param momentSeconds  the podcaster's key moment, or null
     * @param imageRef       the uploaded image's ref, or null — the page derives its URL with
     *                       {@code ctx.blobs.urlFor} at render time, never a stored URL
     * @param favourites     how many visitors marked it, from the same tally {@link FavouriteCount} publishes
     */
    record IndexEntry(String slug, String excerpt, Integer momentSeconds, String imageRef, int favourites) {
    }

    /**
     * Every highlighted episode in one document, published to {@code data/site/main/index}.
     *
     * <p><strong>Why the backend owes the page this.</strong> The plugin's page renders four views over the
     * same data — all highlights, only those with a key moment, only those with an image, and (for a
     * podcaster) the episodes with none. A browser cannot assemble any of them: the host's doc surface is
     * addressed by scope and key, so a frontend wanting every episode's highlight has to issue one request
     * per episode and then hope none 404s mid-list. The backend already walks exactly that set once per
     * recompute — {@link #recomputeHighlightStats(PluginContext)} — so it publishes the answer instead, and
     * the page costs one GET no matter how long the feed is.
     *
     * <p>This is the same shape as {@code stats}: derived, backend-written, and declared
     * {@code data.backendOwned} so a client {@code PUT} is a 403 rather than a way to invent a listing.
     * It carries only what a card shows — an excerpt, not the body — because the detail view fetches the
     * real document anyway, and an index that duplicates every highlight in full is a second copy free to
     * go stale.
     */
    record HighlightIndex(List<IndexEntry> entries) {
    }

    /**
     * Set once by {@link #register(PluginContext)}; {@link ShareMetadataProvider}/{@link SitemapProvider}
     * have no {@code ctx} parameter of their own, so they reuse this. {@code static} (not a plain instance
     * field) because PF4J instantiates this class separately per extension-point lookup — see the class
     * javadoc for why an instance field silently doesn't work here.
     */
    private static volatile PluginContext ctx;

    /**
     * Test seam: clears the classloader-scoped context. Only tests need this — at runtime the field is
     * written once by {@link #register(PluginContext)} and lives as long as the plugin's classloader.
     * Because the field is {@code static}, leaving it set would leak between test methods and let a test
     * that forgot to {@code register()} silently pass on a previous test's context.
     */
    static void clearContextForTests() {
        ctx = null;
    }

    @Override
    public void register(PluginContext ctx) {
        SamplePlugin.ctx = Objects.requireNonNull(ctx, "ctx");

        int minutes = ctx.config().get("refreshIntervalMinutes", Integer.class, DEFAULT_REFRESH_MINUTES);
        if (minutes <= 0) {
            // onSchedule throws for a non-positive duration, which disables the whole plugin at next
            // startup (ARCHITECTURE §7.8) — clamp defensively rather than trust a podcaster-editable
            // config value, but tell an operator why the effective interval doesn't match what's configured.
            ctx.logger().warn("configured refreshIntervalMinutes={} is not positive; clamping to 1 minute", minutes);
        }
        Duration interval = Duration.ofMinutes(Math.max(1, minutes));

        ctx.logger().info("registered; recomputing highlight stats every {}", interval);
        // Recompute once now, then on the schedule. The eager pass is not just for freshness: `stats` and
        // `favourites` are declared `data.backendOwned` (SDK 0.6.0), which refuses *new* client writes but
        // does not remove a document forged before the declaration existed. A backend that only wrote on
        // its schedule would keep serving that forgery until the next tick — up to refreshIntervalMinutes.
        recomputeHighlightStats(ctx);
        ctx.onSchedule(interval, () -> recomputeHighlightStats(ctx));
    }

    private static void recomputeHighlightStats(PluginContext ctx) {
        List<String> episodeIds = ctx.feeds().episodesIn(Scope.site());
        Map<String, Integer> favourites = tallyFavourites(ctx);
        // Every blob ref a highlight still points at, gathered as we already walk the docs. Feeding the
        // sweep from the same pass is what keeps the two consistent: a ref added between "collect" and
        // "delete" would otherwise be a live image with nothing claiming it.
        Set<String> referencedImages = new HashSet<>();
        collectImageRef(ctx.store().query(Scope.site(), "highlight"), referencedImages);
        int highlighted = 0;
        int withMoment = 0;
        int pruned = 0;
        int totalFavourites = 0;
        // Built in the same pass for the same reason the image refs are: a second walk could disagree with
        // this one, and the page would then list an episode whose highlight this pass just pruned.
        List<IndexEntry> index = new ArrayList<>();
        for (String id : episodeIds) {
            totalFavourites += publishFavouriteCount(ctx, id, favourites.getOrDefault(id, 0));
            // A "highlight" doc key is unique per episode scope, so this keyPrefix scan returns at most
            // one entry — used anyway (instead of store().get(..., Highlight.class)) to demonstrate the
            // Jackson-3 JsonNode path a real prefix scan hands back (see DocEntry's javadoc), and to read
            // defensively rather than trust a doc a different plugin version wrote in a shape
            // Highlight.class couldn't deserialize. Contrast with metaFor()/urls() below, which stay on
            // the typed store().get(..., Highlight.class) path and never see a JsonNode at all.
            for (DocEntry entry : ctx.store().query(Scope.episode(id), "highlight")) {
                JsonNode node = entry.value();
                JsonNode markdown = node.path("markdown");
                if (!markdown.isString() || markdown.stringValue().isBlank()) {
                    // A contentless highlight doc is junk: it is what an older version of this plugin left
                    // behind when a podcaster "removed" a highlight by blanking the textarea (there was no
                    // Remove button before 2.5.0). Left in place it warns on every recompute forever, and —
                    // worse — still counts as present for urls()/metaFor(), putting the episode in
                    // sitemap.xml with an empty OpenGraph description. So prune it rather than skip it.
                    // delete() is idempotent and reports whether anything was actually removed; a false
                    // here means a concurrent writer got there first, which is not an error.
                    boolean removed = ctx.store().delete(Scope.episode(id), entry.key());
                    if (removed) {
                        pruned++;
                    }
                    ctx.logger().warn(
                            "episode {} had a highlight doc with a missing/blank 'markdown' field; pruned it (removed={})",
                            id, removed);
                    continue;
                }
                highlighted++;
                Integer moment = node.path("momentSeconds").isNumber() ? node.path("momentSeconds").asInt() : null;
                if (moment != null) {
                    withMoment++;
                }
                rememberImageRef(node, referencedImages);
                JsonNode ref = node.path("image").path("ref");
                index.add(new IndexEntry(
                        id,
                        excerpt(markdown.stringValue()),
                        moment,
                        ref.isString() ? ref.stringValue() : null,
                        favourites.getOrDefault(id, 0)));
            }
        }
        sweepOrphanedImages(ctx, referencedImages);
        ctx.logger().info(
                "recomputed highlight stats: {}/{} episodes highlighted ({} with a key moment, {} empty doc(s) pruned,"
                        + " {} favourite(s) across all visitors)",
                highlighted, episodeIds.size(), withMoment, pruned, totalFavourites);
        ctx.store().put(Scope.site(), "stats", new HighlightStats(episodeIds.size(), highlighted, withMoment, totalFavourites));
        // Published after the prune above, so a doc removed in this pass never appears in the listing.
        ctx.store().put(Scope.site(), "index", new HighlightIndex(index));
    }

    /** Adds the {@code image.ref} of every entry in {@code entries} to {@code refs}. */
    private static void collectImageRef(List<DocEntry> entries, Set<String> refs) {
        for (DocEntry entry : entries) {
            rememberImageRef(entry.value(), refs);
        }
    }

    /**
     * Records the blob ref a highlight document points at, if it has one.
     *
     * <p>Read defensively off the {@code JsonNode} rather than through a typed binding: this walks
     * documents an older or newer build of the plugin may have written, and the sweep below <em>deletes</em>
     * based on the answer. A shape this method fails to understand must read as "no ref", which costs a
     * leaked file; guessing wrong in the other direction costs a podcaster their image.
     */
    private static void rememberImageRef(JsonNode highlight, Set<String> refs) {
        JsonNode ref = highlight.path("image").path("ref");
        if (ref.isString() && !ref.stringValue().isBlank()) {
            refs.add(ref.stringValue());
        }
    }

    /**
     * Deletes uploaded images no highlight points at any more (SDK 0.8.0, {@link PluginContext#blobs()}).
     *
     * <p><strong>Nothing on this platform collects orphans.</strong> A blob outlives the document that
     * named it and only this plugin knows which those are, so the choice is between sweeping here and
     * leaking a file every time a podcaster swaps a picture. The frontend deletes the ref it just stopped
     * pointing at, which handles the ordinary case; this is the net under it, for the tab closed
     * mid-edit and the {@code remove} call that failed. Being a scheduled backend job is not incidental —
     * it is the only place a whole-store view exists.
     *
     * <p><strong>Why this is safe to run, and the constraint that makes it so.</strong> A sweep may only
     * delete what it can prove is unreferenced, so it may only run over scopes this backend can
     * <em>enumerate</em>: {@link Scope#site()} is a singleton, and {@link dev.mosaicast.plugin.api.FeedAccess#episodesIn}
     * yields every episode. There is deliberately no third case — {@code FeedAccess} exposes no way to
     * list feeds, so a feed-scope highlight is invisible from here, and this plugin therefore never
     * <em>writes</em> an image at feed scope (see the upload gate in {@code Highlight.tsx}). That pairing
     * is the whole lesson for anyone copying this: <em>what your backend can enumerate bounds what it can
     * safely garbage-collect</em>. Widen where images may be attached and you must widen this first, or
     * the next tick quietly deletes them.
     */
    private static void sweepOrphanedImages(PluginContext ctx, Set<String> referenced) {
        var blobs = ctx.blobs();
        if (blobs == null) {
            // Null unless the manifest declares a `blobs` block — and an operator may refuse it on their
            // install even though this one declares it. No storage, nothing to sweep.
            return;
        }
        // Page the whole list *before* deleting anything. Removing entries from a collection being paged
        // shifts the rest forward, so a cursor that advanced between deletions would step over exactly as
        // many blobs as it removed — and they would survive until a later tick happened to catch them.
        // Two phases, no such interaction.
        List<String> orphans = new ArrayList<>();
        for (int page = 0; ; page++) {
            List<BlobInfo> batch = blobs.list(page, BLOB_SWEEP_PAGE_SIZE);
            for (BlobInfo blob : batch) {
                if (!referenced.contains(blob.ref())) {
                    orphans.add(blob.ref());
                }
            }
            if (batch.size() < BLOB_SWEEP_PAGE_SIZE) {
                break;
            }
        }
        int deleted = 0;
        for (String ref : orphans) {
            // Idempotent, so losing a race with the frontend's own cleanup is not an error — it reports
            // false and the counter simply does not move.
            if (blobs.delete(ref)) {
                deleted++;
            }
        }
        if (deleted > 0) {
            ctx.logger().info("swept {} orphaned highlight image(s)", deleted);
        }
    }

    /**
     * Counts every visitor's {@code fav:<episodeSlug>} mark, keyed by episode slug.
     *
     * <p>{@link dev.mosaicast.plugin.api.DocStore#queryAcrossUsers(String)} is the backend's <em>only</em>
     * window onto {@code USER} partitions: {@code store().get(Scope.user(), …)} and friends throw
     * {@link UnsupportedOperationException}, because a scheduled task has no calling user and resolving
     * {@code "me"} without one would have to pick somebody. There is no HTTP surface for this method
     * either, so a visitor's request cannot reach another visitor's marks through it.
     *
     * <p>Each entry's {@link dev.mosaicast.plugin.api.OwnedDocEntry#userId() userId} is ignored here — one
     * mark per user per episode already, so the count <em>is</em> the number of distinct visitors. A
     * plugin that stored several docs per user would deduplicate on it; it is also what a moderation view
     * would key on, and it is host-resolved, so it can be trusted for that.
     */
    private static Map<String, Integer> tallyFavourites(PluginContext ctx) {
        Map<String, Integer> byEpisode = new HashMap<>();
        for (OwnedDocEntry entry : ctx.store().queryAcrossUsers(FAVOURITE_KEY_PREFIX)) {
            // An explicit `false` means "unfavourited but written, not deleted" — an older client, or a
            // failed delete. Counting mere presence would report a favourite the visitor removed.
            if (entry.value().isBoolean() && !entry.value().booleanValue()) {
                continue;
            }
            String slug = entry.key().substring(FAVOURITE_KEY_PREFIX.length());
            if (!slug.isBlank()) {
                byEpisode.merge(slug, 1, Integer::sum);
            }
        }
        return byEpisode;
    }

    /**
     * Publishes (or clears) an episode's favourite count and returns it.
     *
     * <p>Zero is written as a <em>deletion</em>, not as {@code {"count": 0}}: an episode nobody has
     * favourited yet and one whose last favourite was withdrawn are the same state, and the frontend
     * already renders a missing doc as "no favourites". Leaving a zero doc behind would also keep it alive
     * for episodes that have long since dropped out of the feed.
     */
    private static int publishFavouriteCount(PluginContext ctx, String episodeId, int count) {
        if (count == 0) {
            ctx.store().delete(Scope.episode(episodeId), FAVOURITE_COUNT_KEY);
        } else {
            ctx.store().put(Scope.episode(episodeId), FAVOURITE_COUNT_KEY, new FavouriteCount(count));
        }
        return count;
    }

    /**
     * The highlight for {@code slug}, but only if it actually carries content.
     *
     * <p>{@code metaFor}/{@code urls} both need this rather than a bare {@code store().get(...)}: a
     * highlight doc with blank markdown is present but has nothing to show, and treating "present" as
     * "publishable" is what put contentless episodes into {@code sitemap.xml} with an empty OpenGraph
     * description. {@link #recomputeHighlightStats(PluginContext)} prunes such docs, but only on its
     * schedule — these two run per request and must not depend on that having happened yet.
     */
    private static Optional<Highlight> publishableHighlight(PluginContext ctx, String slug) {
        return ctx.store()
                .get(Scope.episode(slug), "highlight", Highlight.class)
                .filter(highlight -> highlight.markdown() != null && !highlight.markdown().isBlank());
    }

    @Override
    public Optional<OgMeta> metaFor(String subpath) {
        PluginContext ctx = SamplePlugin.ctx;
        if (ctx == null || subpath == null || !subpath.startsWith(HIGHLIGHT_SUBPATH_PREFIX)) {
            return Optional.empty();
        }
        String slug = subpath.substring(HIGHLIGHT_SUBPATH_PREFIX.length());
        if (slug.isBlank()) {
            return Optional.empty();
        }
        return publishableHighlight(ctx, slug).map(highlight -> {
            DisplaySnapshot snapshot = ctx.feeds().display(slug);
            return new OgMeta(snapshot.title(), excerpt(highlight.markdown()), snapshot.artwork());
        });
    }

    @Override
    public List<SitemapUrl> urls() {
        PluginContext ctx = SamplePlugin.ctx;
        if (ctx == null) {
            return List.of();
        }
        return ctx.feeds().episodesIn(Scope.site()).stream()
                .filter(slug -> publishableHighlight(ctx, slug).isPresent())
                .map(slug -> new SitemapUrl("/p/sample/" + HIGHLIGHT_SUBPATH_PREFIX + slug, null))
                .toList();
    }

    /** Strips the most common markdown tokens and collapses whitespace, for a plain-text OG description. */
    private static String excerpt(String markdown) {
        String plain = WHITESPACE_RUN.matcher(MARKDOWN_TOKENS.matcher(markdown).replaceAll("")).replaceAll(" ").trim();
        return plain.length() <= DESCRIPTION_EXCERPT_LENGTH ? plain : plain.substring(0, DESCRIPTION_EXCERPT_LENGTH).trim() + "…";
    }
}
