// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import dev.mosaicast.plugin.api.BlobInfo;
import dev.mosaicast.plugin.api.CrossUserStore;
import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.EpisodePhase;
import dev.mosaicast.plugin.api.DocEntry;
import dev.mosaicast.plugin.api.LocaleInfo;
import dev.mosaicast.plugin.api.NotificationException;
import dev.mosaicast.plugin.api.Notifier;
import dev.mosaicast.plugin.api.NotifyMessage;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.OwnedDocEntry;
import dev.mosaicast.plugin.api.PageRouteProvider;
import dev.mosaicast.plugin.api.PluginBackend;
import dev.mosaicast.plugin.api.PluginContext;
import dev.mosaicast.plugin.api.Role;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.SearchHit;
import dev.mosaicast.plugin.api.SearchProvider;
import dev.mosaicast.plugin.api.ShareMetadataProvider;
import dev.mosaicast.plugin.api.SitemapProvider;
import dev.mosaicast.plugin.api.SitemapUrl;
import dev.mosaicast.plugin.api.Tags;
import dev.mosaicast.plugin.api.Translation;
import dev.mosaicast.plugin.api.TranslationException;
import dev.mosaicast.plugin.api.TranslationRequest;
import dev.mosaicast.plugin.api.TranslationResult;
import dev.mosaicast.plugin.api.UserDataHandler;
import dev.mosaicast.plugin.api.UserRef;
import dev.mosaicast.plugin.api.Users;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
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
 *       partition via {@link dev.mosaicast.plugin.api.CrossUserStore#query(String) ctx.allUsers().query(...)} and publishes a
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
 *       incidental — it is the only place a whole-store view exists. An admin can put it in report-only
 *       mode with the manifest's {@code imageSweep} config field, which is also where this plugin
 *       demonstrates a closed {@code options} set on a setting whose typo would otherwise cost files.
 *   <li><strong>Serve deep links</strong> ({@code /p/sample/highlight/<episodeSlug>}, ARCHITECTURE §6.4):
 *       this class also implements {@link ShareMetadataProvider} (OpenGraph tags for link scrapers) and
 *       {@link SitemapProvider} ({@code sitemap.xml} entries) — and since SDK 0.12.0 both of them
 *       <strong>say what language the page is in</strong>: {@link OgMeta#locale()} and
 *       {@link SitemapUrl#alternates()}, the plugin's half of core's {@code ?lang=} URLs and
 *       {@code hreflang} groups (§6.6, §12.7). See {@link #urls()}.
 *   <li><strong>Answer for its own subtree</strong> (SDK 0.9.1, ARCHITECTURE §6.6): {@link
 *       #hasRoute(String)} tells the host which subpaths under {@code /p/sample/} are real, so a typo or a
 *       deleted highlight gets a genuine {@code 404} instead of this plugin's not-found view inside a
 *       {@code 200 OK}. Core knows a {@code page} slot was declared; it cannot know what this plugin
 *       renders, which is the whole reason the interface exists.
 *   <li><strong>Contribute to the site's search</strong> (SDK 0.9.0, §6.7): {@link #search(String, Role,
 *       int)} puts highlights into {@code /api/search} instead of this plugin growing a second search box
 *       on the same site. This is the one place in the contract where <em>access is the plugin's job</em>
 *       — see that method.
 *   <li><strong>Answer for a departing account</strong> (SDK 0.9.0, §12.8): {@link #eraseUser(String)} and
 *       {@link #exportUser(String)}. Core drops the {@code USER}-scope marks themselves; what it cannot do
 *       is repair the three published documents that <em>counted</em> them.
 *   <li><strong>Mirror the site's tags</strong> (SDK 0.9.0, §6.1.1): {@link #mirrorTags} copies an
 *       episode's tags onto this plugin's own subject, so a highlight and an episode about the same thing
 *       share one vocabulary rather than two look-alike strings.
 *   <li><strong>Put a name to a byline</strong> (SDK 0.13.0, §8.8): {@link #metaFor(String)} turns the
 *       highlight's stored {@code authorId} into a person with {@link PluginContext#users()}, so a link
 *       preview says who wrote it. <strong>Resolved, never stored</strong> — a display name copied into
 *       this plugin's own documents would outlive the rename meant to shed it and the erasure meant to end
 *       it, and §12.8 cannot reach inside a plugin's storage to fix either.
 *   <li><strong>Tell a listener their highlight now speaks their language</strong> (SDK 0.14.0, §17): the
 *       scheduled pass notices a highlight gaining a content locale it had not published before and puts a
 *       message in the inbox of everyone who favourited it, via {@link PluginContext#notifier()}. See
 *       {@link #announceTranslations}. This is the one surface here that writes into <em>somebody else's</em>
 *       view of the site, and the host bounds it twice — only users this plugin already holds
 *       {@code USER}-scope rows for are eligible, and the rate limits are the host's.
 * </ul>
 *
 * <p><strong>Six extension points, one class</strong> — which is a packaging choice, not a requirement:
 * each is an independent {@code ExtensionPoint} and a plugin may implement none of them. They live
 * together here because they share {@link #ctx} and the {@link #publishableHighlight} predicate, and
 * because the sample is easier to read as one file.
 *
 * <p><strong>Confirmed live against a running core (ARCHITECTURE §6.4/§6.6 now implemented):</strong>
 * {@code GET /p/sample/highlight/<slug>} and {@code /sitemap.xml} really do call {@link #metaFor(String)}/
 * {@link #urls()}. Doing so once surfaced a PF4J gotcha worth recording, because <em>core fixed it and the
 * workaround is now wrong</em>: PF4J's default {@code ExtensionFactory} builds a <strong>separate
 * instance</strong> per extension-point type it looks up, so a field set in {@link #register(PluginContext)}
 * was invisible to {@code metaFor}/{@code urls} — they ran on a different object and threw. This class
 * carried a {@code static} field to work around it. Since <strong>core 0.6.7</strong> the host installs
 * PF4J's {@code SingletonExtensionFactory}, which caches by class, so all six extension points run on the
 * one instance {@code register()} ran on and {@link #ctx} is an ordinary instance field again. Sharing state
 * through a {@code static} would now be a leak between reloads of the same plugin rather than a fix.
 *
 * <p><strong>What has not changed is that a lookup may arrive before {@code register()}.</strong> Core
 * resolves {@link ShareMetadataProvider}/{@link SitemapProvider} independently of {@link PluginBackend}, so
 * {@link #metaFor(String)} and {@link #urls()} still treat a null {@link #ctx} as "nothing to contribute"
 * rather than dereferencing it — a lookup that happens first must degrade to no OG tags and no sitemap
 * entries, not throw into core's per-provider {@code try}/{@code catch} and silently serve a wrong page.
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
public class SamplePlugin implements PluginBackend, ShareMetadataProvider, SitemapProvider,
        PageRouteProvider, SearchProvider, UserDataHandler {

    /** Fallback used when the podcaster has not configured {@code refreshIntervalMinutes}. */
    static final int DEFAULT_REFRESH_MINUTES = 30;

    /** {@code imageSweep}: delete every uploaded image no highlight points at. The manifest's default. */
    static final String SWEEP_DELETE = "delete";

    /** {@code imageSweep}: name the orphans in the log and delete nothing. */
    static final String SWEEP_REPORT = "report";

    /** The deep-link subpath prefix this plugin serves: {@code /p/sample/highlight/<episodeSlug>}. */
    private static final String HIGHLIGHT_SUBPATH_PREFIX = "highlight/";

    /**
     * The fixed entrances this plugin's page renders, mirroring {@code plugin.json}'s {@code nav[]} and the
     * frontend's own {@code PAGE_ENTRIES}.
     *
     * <p><strong>The empty string is in this set on purpose.</strong> {@code subpath} is empty at
     * {@code /p/sample/}, and a provider written as a lookup over a plugin's content answers {@code false}
     * there and 404s its own landing page. That is the mistake the SDK's harness probes for whether a test
     * asks it to or not.
     */
    private static final Set<String> PAGE_SUBPATHS = Set.of("", "moments", "gallery", "unwritten");

    /**
     * The one entrance in {@link #PAGE_SUBPATHS} that {@code nav[]} gates to a podcaster.
     *
     * <p>{@link #hasRoute(String)} deliberately does <em>not</em> consult this: whether a route exists and
     * who may see what is behind it are different questions, and the host already refuses the view itself.
     * {@link #search(String, Role, int)} does consult it, because a search result is content.
     */
    private static final String PODCASTER_SUBPATH = "unwritten";

    /**
     * Namespace for this plugin's tag subjects (ARCHITECTURE §6.1.1).
     *
     * <p>The key is opaque to the host and this plugin's to invent — the same property {@code SchemaStore}
     * has for tables and {@code ctx.route.navigate} has for URLs. It is built from the episode slug so a
     * tag and a {@link SearchHit} name <em>one</em> object rather than two.
     */
    private static final String SUBJECT_KEY_PREFIX = "highlight:";

    /** Longest snippet carried into a {@link SearchHit}; the host shows one line under the title. */
    private static final int SNIPPET_LENGTH = 160;

    /** Doc key holding this episode's {@link TranslationDrafts}; declared {@code data.backendOwned}. */
    static final String DRAFTS_KEY = "drafts";

    /**
     * How many provider calls one scheduled pass may make.
     *
     * <p>A ceiling on somebody else's bill, not a performance tuning knob. The pass runs on a timer with
     * nobody watching, so an unbounded walk over a long feed is how a plugin spends a site's whole
     * translation allowance in one night. Small enough that a backlog drains over several ticks — the host
     * caches by text and provider, so re-reaching an episode it has already drafted costs nothing.
     */
    private static final int DRAFTS_PER_PASS = 5;

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

    /** Doc key holding this episode's {@link AnnouncedLocales}; declared {@code data.backendOwned}. */
    static final String ANNOUNCED_KEY = "announced";

    /**
     * How many episodes one scheduled pass may announce translations for.
     *
     * <p>The same shape as {@link #DRAFTS_PER_PASS} and for a related reason: the host's own per-recipient
     * cap is the real limit, and hitting it is a {@link NotificationException.Reason#RATE_LIMITED} that
     * costs the rest of the pass. Draining a backlog over several ticks stays under it without this code
     * having to model a limit it cannot read.
     */
    private static final int ANNOUNCEMENTS_PER_PASS = 3;

    /**
     * What an announcement says, per locale — {@code {0}} is the episode, {@code {1}} the new language.
     *
     * <p><strong>Why a constant here rather than {@code frontend/locales/*.json}.</strong> A plugin's
     * catalogs ship inside its <em>frontend bundle</em> (§12.7) and load when its Web Component mounts; a
     * backend running on a timer has no reader, no mount and no access to them. That is the same fact that
     * makes {@link NotifyMessage} carry finished sentences rather than a translation key (§17.1) — the bell
     * is shell chrome and renders on pages where this plugin's JavaScript never runs, so a key would reach
     * a reader as the literal string. Keeping the wording here, next to the code that sends it, is honest
     * about that; sharing one catalog across the two halves is a thing this contract cannot do yet.
     *
     * <p>{@code en} is mandatory: §12.7 makes English the one language a site cannot switch off, so it is
     * the only fallback every reader is guaranteed to understand, and {@link NotifyMessage}'s constructor
     * refuses a map without it.
     */
    private static final Map<String, String> NOTIFY_TEMPLATES = Map.of(
            "en", "The highlight you saved for \"{0}\" is now available in {1}.",
            "de", "Das Highlight, das du dir für „{0}“ gemerkt hast, gibt es jetzt auf {1}.");

    /** Page size for walking this plugin's blobs during the orphan sweep; the host caps what it honours. */
    private static final int BLOB_SWEEP_PAGE_SIZE = 100;

    /** Longest excerpt of a highlight's markdown carried into {@link OgMeta#description()}. */
    private static final int DESCRIPTION_EXCERPT_LENGTH = 160;

    /** Markdown punctuation dropped by {@link #excerpt(String)}; precompiled — {@code urls()} runs per request. */
    private static final Pattern MARKDOWN_TOKENS = Pattern.compile("[#*_`|\\[\\]()]");

    /**
     * A {@code <style>}/{@code <script>} element <em>with its content</em>. Markdown passes raw HTML through,
     * and {@code ctx.sanitize} drops both on the page — so their text is not part of what a reader sees and
     * must not become the share preview or the search snippet either.
     */
    private static final Pattern HTML_NON_TEXT = Pattern.compile("(?is)<(style|script)\\b.*?</\\1\\s*>");

    /** Any other HTML tag; its text content stays, as it does on the rendered page. */
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]*>");

    /** A GFM table's delimiter row ({@code |:---|:---:|}), which renders as nothing and reads as noise. */
    private static final Pattern TABLE_RULE = Pattern.compile("(?m)^[ \\t]*\\|?[ \\t]*:?-+:?[ \\t]*(\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t]*$");

    /** Collapses newlines/indentation into single spaces for a one-line OG description. */
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");

    /**
     * Mirrors the frontend's stored highlight shape at every scope: default-locale {@code markdown}, plus the
     * podcaster's translations of it keyed by content locale (see the frontend's {@code HighlightDoc}).
     *
     * <p>The doc carries more than this — {@code momentSeconds}, {@code image} — which the store's mapper
     * ignores. Only what a backend code path actually reads is modelled here; {@link #urls()} needs the
     * translation keys, and {@link #recomputeHighlightStats(PluginContext)} reads the rest as
     * {@link JsonNode} because it is walking a prefix scan rather than one known document.
     *
     * @param markdown     the highlight's text in the site's default content locale
     * @param translations the same highlight in other content locales, keyed by locale code; never
     *                     {@code null} after construction, and <strong>never trusted</strong> — see
     *                     {@link #translationGroup} for why these keys are input
     * @param authorId     the UUID of whoever first wrote it, or {@code null}. <strong>A byline, not an
     *                     authorization fact.</strong> It sits in a shared-scope document, which has no
     *                     owner — anything above {@code data.writableBy} could {@code PUT} any UUID here,
     *                     exactly as it could rewrite the prose. Nothing is decided on it: it is resolved
     *                     to a name for display and for {@link OgMeta#description()} and that is all. The
     *                     ids this plugin genuinely knows to be true are the ones the host resolves from a
     *                     partition — see {@link #tallyFavourites}
     */
    record Highlight(String markdown, Map<String, HighlightTranslation> translations, String authorId) {

        /** Normalises a document that predates translations, or that stored {@code null} for them. */
        Highlight {
            translations = translations == null ? Map.of() : Map.copyOf(translations);
        }

        /**
         * A highlight with a byline but nothing translated.
         *
         * @param markdown the highlight's text in the site's default content locale
         * @param authorId the UUID of whoever wrote it, or {@code null}
         */
        Highlight(String markdown, String authorId) {
            this(markdown, Map.of(), authorId);
        }

        /**
         * A highlight with nothing translated and no byline — every document written before SDK 0.10.0.
         *
         * <p>Kept as a real constructor for the same reason {@code OgMeta}/{@code SitemapUrl} kept theirs in
         * 0.12.0: the old shape is still the common one, and a convenience constructor is cheaper than
         * editing every call site that has nothing to say about language.
         *
         * @param markdown the highlight's text in the site's default content locale
         */
        Highlight(String markdown) {
            this(markdown, Map.of(), null);
        }

        /**
         * A highlight with translations and no byline.
         *
         * @param markdown     the highlight's text in the site's default content locale
         * @param translations the same highlight in other content locales
         */
        Highlight(String markdown, Map<String, HighlightTranslation> translations) {
            this(markdown, translations, null);
        }
    }

    /**
     * One highlight's text in a content locale other than the site default.
     *
     * <p>Modelled with only the field the sitemap cares about. {@code machineTranslated} is stored beside it
     * and is a <em>reader's</em> concern — it decides whether the page shows a "translated automatically"
     * badge, not whether the page exists in that language, and a translation a human never confirmed is
     * still a page written in German.
     *
     * @param markdown the translated text; blank means the tab was opened and never filled in
     */
    record HighlightTranslation(String markdown) {
    }

    /**
     * Mirrors the frontend's {@code stats} doc shape, read at {@code data/site/main/stats}.
     *
     * <p>Written here only, and declared {@code data.backendOwned} so the host refuses a client write to it —
     * the forged {@code PUT} in the SDK's 0.6.0 migration guide is a forged {@code stats} on this plugin.
     */
    record HighlightStats(int totalEpisodes, int highlightedEpisodes, int episodesWithMoment, int totalFavourites,
            int fullyTranslated, int strandedTranslations) {
    }

    /**
     * One machine-drafted translation the schedule produced, published to
     * {@code data/episode/<slug>/drafts} (SDK 0.10.0, {@link dev.mosaicast.plugin.api.Translation}).
     *
     * <p><strong>Deliberately not the highlight document.</strong> The contract's rule is that machine
     * output is a draft and must not be shown as fact, and the only way a backend can honour that is to put
     * it somewhere the reader never looks. This document is read by the edit modal and by nothing else: the
     * podcaster sees a suggestion, and the words reach a visitor only once a human pressed Save.
     *
     * <p><strong>And deliberately {@code backendOwned}.</strong> Nothing else about it would stop a client
     * writing a "suggestion" that the editor then offers the podcaster in good faith — a shared-scope
     * document has no owner, so anything above {@code writableBy} could put any text under any locale here.
     *
     * @param locale     the content locale this draft is written in
     * @param markdown   the draft text
     * @param providerId which provider produced it, so a podcaster can weigh the suggestion
     * @param sourceHash the source text this was translated from, hashed — see
     *                   {@link #draftTranslations(PluginContext, String, String, Map, List)} for why a
     *                   draft has to be able to tell that its original has since been rewritten
     */
    record TranslationDraft(String locale, String markdown, String providerId, int sourceHash) {
    }

    /** Every machine draft for one episode, published to {@code data/episode/<slug>/drafts}. */
    record TranslationDrafts(List<TranslationDraft> drafts) {
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
     * Which content locales this episode's highlight has already been announced in, published to
     * {@code data/episode/<slug>/announced} (SDK 0.14.0, {@link Notifier}).
     *
     * <p><strong>Bookkeeping, not content.</strong> Nothing renders this — it exists so
     * {@link #announceTranslations} can tell a translation that is <em>new</em> from one it already told
     * everybody about. Without it the scheduled pass would re-announce the same German highlight on every
     * tick, which is the failure mode a rate limit exists to survive rather than a design to rely on.
     *
     * <p><strong>Seeded on first sight, never backfilled.</strong> The first pass that sees an episode
     * records its current locales and notifies nobody. The alternative — treat an empty record as "nothing
     * announced yet" — would fire one notification per existing translation at every existing favouriter
     * the moment this version is installed, which is a spam cannon dressed as a migration.
     *
     * <p>Declared {@code data.backendOwned} like the documents around it: a client that could {@code PUT}
     * here could either silence an announcement or, by clearing it, make the plugin announce everything
     * again.
     *
     * @param locales the content locale codes already announced; never {@code null} after construction
     */
    record AnnouncedLocales(Set<String> locales) {

        /** Normalises a document written before this key existed, or one that stored {@code null}. */
        AnnouncedLocales {
            locales = locales == null ? Set.of() : Set.copyOf(locales);
        }
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
     * @param authorId       the UUID of whoever first wrote it, or null for a highlight written before
     *                       2.15.0. <strong>A UUID and never a name</strong> (SDK 0.13.0, §8.8): the page
     *                       resolves the whole listing's ids in one {@code ctx.users.resolve} at render, so
     *                       a rename is visible immediately and an erased account leaves a placeholder
     *                       instead of a name nobody can withdraw
     */
    record IndexEntry(String slug, String excerpt, Integer momentSeconds, String imageRef, int favourites,
            String authorId) {
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
     * have no {@code ctx} parameter of their own, so they reuse this.
     *
     * <p>A plain instance field, which is correct since core 0.6.7 installs PF4J's
     * {@code SingletonExtensionFactory} — every extension point resolves to the instance {@code register()}
     * ran on. {@code volatile} because that instance is written on the host's startup thread and read on
     * request threads. See the class javadoc for the {@code static} workaround this replaced.
     */
    private volatile PluginContext ctx;

    /** Sentinel for {@link #lastLoggedRefreshMinutes}: no value has been logged yet. */
    private static final int REFRESH_MINUTES_UNLOGGED = Integer.MIN_VALUE;

    /**
     * The last {@code refreshIntervalMinutes} {@link #refreshInterval(PluginContext)} logged about, so it
     * can report a change rather than every tick.
     *
     * <p>{@code volatile} for the same reason {@link #ctx} is: written on the host's startup thread during
     * {@code register()} and then on a scheduler thread before each fire. A lost update here costs one
     * duplicate or one missing log line and nothing else, so a plain field would be defensible — but a
     * torn {@code int} read is not worth the argument.
     */
    private volatile int lastLoggedRefreshMinutes = REFRESH_MINUTES_UNLOGGED;

    @Override
    public void register(PluginContext ctx) {
        this.ctx = Objects.requireNonNull(ctx, "ctx");

        ctx.logger().info("registered; recomputing highlight stats every {}", refreshInterval(ctx));
        // Recompute once now, then on the schedule. The eager pass is not just for freshness: `stats` and
        // `favourites` are declared `data.backendOwned` (SDK 0.6.0), which refuses *new* client writes but
        // does not remove a document forged before the declaration existed. A backend that only wrote on
        // its schedule would keep serving that forgery until the next tick — up to refreshIntervalMinutes.
        recomputeHighlightStats(ctx, null);
        // A supplier, not a Duration (SDK 0.15.0). The Duration overload captures its value here, during
        // register(), and the host holds it for the life of the process — so a podcaster saving a new
        // refreshIntervalMinutes got a form that said "saved", a stored value that read back correctly,
        // and a plugin still recomputing at the old cadence until someone restarted core. Nothing on
        // either screen said so. Handing over the *reading* of the period instead lets the host re-read it
        // before every tick and reschedule when the answer differs, so an edit lands within one old period.
        ctx.onSchedule(() -> refreshInterval(ctx), () -> recomputeHighlightStats(ctx, null));
        // SDK 0.19.0. Everything this backend publishes leaves a quiet planned episode out (see isQuiet), so
        // any write that moves an episode's phase changes what it should publish: an announcement lists it, an
        // announcement moved later or a withdrawal must un-list it, a cancellation (phase null) drops it. The
        // second kind is the one that cannot wait for the schedule — until the next pass the public `index`
        // and `stats` docs would keep naming an episode the site is hiding again (SDK#98).
        //
        // One hook, not two. A release fires onEpisodeReleased and then this one with RELEASED, so 2.19.0's
        // release-hook recompute would now run twice per release for the same answer; this listener sees
        // every write-driven change, release included. What neither hook sees is the clock (PLANNED ->
        // UPCOMING as an announcement passes), which only makes an episode *more* visible — the schedule
        // above reconciles it, and both hooks are best effort by contract anyway.
        ctx.onEpisodePhaseChanged((slug, phase) -> {
            ctx.logger().info("episode {} is now {}; recomputing what is published about it", slug,
                    phase == null ? "gone" : phase);
            requestRecompute(ctx);
        });
    }

    /** Set by every phase event; cleared by the pass that will see its effect. See {@link #requestRecompute}. */
    private final AtomicBoolean recomputeRequested = new AtomicBoolean();

    /** Held by the one thread running coalesced passes; everyone else hands their request over and leaves. */
    private final ReentrantLock recomputeRunner = new ReentrantLock();

    /**
     * Asks for a recompute, coalescing a burst of phase events into as few passes as the burst needs.
     *
     * <p>Each phase event arrives on a thread of its own, many at once and in no order (SDK 0.19.1): deleting
     * a feed sends one per episode, a manual match one for each side. Every pass reads the whole site, so one
     * pass after the burst answers for all of it — while a pass per event, serialised on the recompute lock,
     * was N full walks of the site queued behind each other for a 200-episode feed.
     *
     * <p>A request always leaves a pass behind it that has not started yet: the runner clears the flag
     * <em>before</em> it walks, and re-checks after releasing the lock, so a request arriving mid-pass is seen
     * by the next one rather than lost between "done" and "unlock". A caller that finds the runner busy
     * returns at once — the event thread is the host's, and holding it buys nothing.
     */
    private void requestRecompute(PluginContext ctx) {
        recomputeRequested.set(true);
        while (recomputeRequested.get() && recomputeRunner.tryLock()) {
            try {
                if (recomputeRequested.getAndSet(false)) {
                    recomputeHighlightStats(ctx, null);
                }
            } finally {
                recomputeRunner.unlock();
            }
        }
    }

    /**
     * The period between two recomputes, re-read from config on every call.
     *
     * <p>Handed to {@link PluginContext#onSchedule(java.util.function.Supplier, Runnable)} rather than
     * evaluated once, which is the whole point: {@code refreshIntervalMinutes} is
     * {@code editableBy: "podcaster"} in the manifest, so its value is expected to change under a running
     * plugin.
     *
     * <p><strong>Cheap and side-effect free, deliberately.</strong> The host calls this on a scheduler
     * thread before every fire. A config read and a comparison is the budget; a store query or anything
     * that blocks does not belong here. The host is also forgiving about the answer — {@code null}, a
     * non-positive {@link Duration} or a throw leaves the task on its last valid period — but only after
     * registration. The value returned during {@code register()} is strict and a non-positive one throws,
     * which would disable this plugin at the next startup (ARCHITECTURE §7.8), so the clamp below is not
     * optional.
     *
     * @param ctx the context to read config from
     * @return a positive period; at least one minute, whatever the podcaster typed
     */
    private Duration refreshInterval(PluginContext ctx) {
        int minutes = ctx.config().get("refreshIntervalMinutes", Integer.class, DEFAULT_REFRESH_MINUTES);
        // Log the *transition*, never the tick. This method now runs once per fire, so an unconditional
        // line here would bury the log at exactly the cadence the operator is trying to tune.
        if (minutes != lastLoggedRefreshMinutes) {
            if (minutes <= 0) {
                ctx.logger().warn("configured refreshIntervalMinutes={} is not positive; clamping to 1 minute",
                        minutes);
            } else if (lastLoggedRefreshMinutes != REFRESH_MINUTES_UNLOGGED) {
                // Only from the second distinct value on: the first one is already in the registration line.
                ctx.logger().info("refreshIntervalMinutes changed to {}; rescheduling", minutes);
            }
            lastLoggedRefreshMinutes = minutes;
        }
        return Duration.ofMinutes(Math.max(1, minutes));
    }

    /**
     * Recomputes and republishes everything this backend derives: {@code stats}, {@code index}, every
     * episode's {@code favourites} count, this plugin's tag subjects, and the orphaned-image sweep.
     *
     * @param excludedUserId a user whose favourite marks must not be counted, or {@code null} for the
     *                       ordinary pass. Only {@link #eraseUser(String)} passes one — see there for why
     *                       a whole recompute is the honest answer to an account deletion
     */
    private static void recomputeHighlightStats(PluginContext ctx, UUID excludedUserId) {
        // One pass at a time. The schedule never overlaps itself, but the phase listener runs on a host
        // thread of its own (SDK 0.19.0) and eraseUser on another — and two concurrent passes would both read
        // `announced` before either wrote it, telling a listener about the same translation twice.
        synchronized (RECOMPUTE_LOCK) {
            recomputeHighlightStatsLocked(ctx, excludedUserId);
        }
    }

    /** Serialises {@link #recomputeHighlightStats(PluginContext, UUID)}; see there. */
    private static final Object RECOMPUTE_LOCK = new Object();

    /**
     * Whether {@code slug} is a planned episode nobody below podcaster may know about yet (SDK 0.18.0).
     *
     * <p><strong>A backend sees quiet episodes; visitors must not.</strong> {@code episodesIn} hands this plugin
     * every planned episode, phase included, because that is when content gets prepared for one — and every
     * public thing this backend derives from that list ({@code index}, {@code stats}, the sitemap, OpenGraph
     * tags, {@code hasRoute}, search hits) would otherwise name an episode the site itself is hiding, with its
     * title and the podcaster's prose attached. The host cannot filter what it cannot see inside.
     *
     * <p>Asked <strong>per use, never cached</strong>: the phase is derived from the clock and moves with
     * nothing written — {@code UPCOMING} when the announcement passes, and back to {@code PLANNED} if a
     * podcaster moves the announcement later. Only {@code PLANNED} is quiet; an {@code UPCOMING} card is
     * public, and a {@code null} phase is a host older than 0.18, where nothing was quiet.
     */
    static boolean isQuiet(PluginContext ctx, String slug) {
        try {
            return ctx.feeds().display(slug).phase() == EpisodePhase.PLANNED;
        } catch (RuntimeException e) {
            // An episode that dropped out between listing and display. Unknown is not public.
            return true;
        }
    }

    private static void recomputeHighlightStatsLocked(PluginContext ctx, UUID excludedUserId) {
        List<String> episodeIds = ctx.feeds().episodesIn(Scope.site());
        // The quiet ones are walked like any other — their highlight is pruned, its image kept and its
        // translations drafted, since preparing is the point of a planned episode — and left out of
        // everything a visitor can read: the counts, the listing, the tag mirror and the announcements.
        Set<String> quiet = new HashSet<>();
        for (String id : episodeIds) {
            if (isQuiet(ctx, id)) {
                quiet.add(id);
            }
        }
        Map<String, List<UUID>> favourites = tallyFavourites(ctx, excludedUserId);
        // Every blob ref a highlight still points at, gathered as we already walk the docs. Feeding the
        // sweep from the same pass is what keeps the two consistent: a ref added between "collect" and
        // "delete" would otherwise be a live image with nothing claiming it.
        Set<String> referencedImages = new HashSet<>();
        collectImageRef(ctx.store().query(Scope.site(), "highlight"), referencedImages);
        int highlighted = 0;
        int withMoment = 0;
        int pruned = 0;
        int totalFavourites = 0;
        // SDK 0.10.0. The languages this site authors content in, read once per pass rather than per
        // episode: it is a registry an admin edits, so it is stable across one recompute and re-reading it
        // mid-walk would let a setting change halfway through and produce a count of nothing coherent.
        List<String> contentLocales = ctx.locales().contentLocales().stream().map(LocaleInfo::code).toList();
        String defaultLocale = ctx.locales().defaultLocale();
        int fullyTranslated = 0;
        int stranded = 0;
        // A budget, not a queue. Every draft is a call to somebody else's metered API, and this runs on a
        // timer with nobody watching — an unbounded pass over a long feed is how a plugin spends a site's
        // whole translation allowance overnight. The host caches, so a re-run of the same text is free and
        // the backlog drains a few episodes per tick until it is empty.
        int draftBudget = DRAFTS_PER_PASS;
        // The same shape, for the notification half: a budget rather than a queue, so a backlog drains over
        // ticks instead of walking straight into the host's per-recipient cap.
        int announceBudget = ANNOUNCEMENTS_PER_PASS;
        int announced = 0;
        // Built in the same pass for the same reason the image refs are: a second walk could disagree with
        // this one, and the page would then list an episode whose highlight this pass just pruned.
        List<IndexEntry> index = new ArrayList<>();
        for (String id : episodeIds) {
            boolean isPublic = !quiet.contains(id);
            List<UUID> favouriters = favourites.getOrDefault(id, List.of());
            totalFavourites += publishFavouriteCount(ctx, id, favouriters.size());
            boolean hasHighlight = false;
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
                rememberImageRef(node, referencedImages);
                Integer moment = node.path("momentSeconds").isNumber() ? node.path("momentSeconds").asInt() : null;
                if (isPublic) {
                    highlighted++;
                    hasHighlight = true;
                    if (moment != null) {
                        withMoment++;
                    }
                }

                // SDK 0.10.0 — the translations the podcaster has actually written, checked against the
                // site's content locales rather than believed. **These keys are client input**: they sit
                // inside a JSON value, so the host's doc-key pattern never sees them and nothing validated
                // them on the way in. `isContentLocale` is the check the SDK puts in the backend for
                // exactly this reason — the browser's list is a hint, and what reaches storage is input.
                Map<String, String> written = new LinkedHashMap<>();
                List<String> strandedHere = new ArrayList<>();
                for (Map.Entry<String, JsonNode> t : node.path("translations").properties()) {
                    JsonNode text = t.getValue().path("markdown");
                    if (!text.isString() || text.stringValue().isBlank()) {
                        continue;
                    }
                    if (!ctx.locales().isContentLocale(t.getKey())) {
                        strandedHere.add(t.getKey());
                        continue;
                    }
                    written.put(t.getKey(), text.stringValue());
                }
                if (!strandedHere.isEmpty()) {
                    // Reported, **not deleted**, and the restraint is the point. A key here is stranded for
                    // two very different reasons that this code cannot tell apart: somebody forged it, or an
                    // admin disabled a language that a podcaster had legitimately written prose in. Deleting
                    // covers the first and destroys somebody's work in the second — and the first is already
                    // harmless, because the frontend only ever *looks up* a locale the host handed it, so a
                    // forged key is unreachable rather than merely unrendered. A count in `stats` and a log
                    // line let an operator decide; a scheduled job silently deleting text does not.
                    stranded += strandedHere.size();
                    ctx.logger().warn(
                            "episode {} has highlight text under {} locale(s) this site does not author content in ({});"
                                    + " left in place — re-enable the language or have the podcaster remove it",
                            id, strandedHere.size(), String.join(", ", strandedHere));
                }
                List<String> translatable = contentLocales.stream().filter(c -> !c.equals(defaultLocale)).toList();
                // The empty-list guard is not pedantry. On a single-language site `translatable` is empty and
                // `containsAll` answers true for every episode, so the figure would read "every highlight is
                // translated into every language" — technically accurate, and a claim about a thing that does
                // not exist. Zero is the honest answer where there is nothing to translate into.
                if (isPublic && !translatable.isEmpty() && written.keySet().containsAll(translatable)) {
                    fullyTranslated++;
                }
                draftBudget = draftTranslations(ctx, id, markdown.stringValue(), written, contentLocales, defaultLocale,
                        draftBudget);
                // SDK 0.14.0. `written` is the set that survived `isContentLocale` above, so an announcement
                // can never name a language the site does not author content in — a notification pointing at
                // a page nobody can render is worse than none. Runs after drafting deliberately: drafts are
                // suggestions nobody has read, and there is nothing to tell a listener about until a human
                // has saved one into the highlight itself.
                if (!isPublic) {
                    // Nothing to tell anybody about an episode they cannot open — and nothing recorded either,
                    // so the first public pass seeds `announced` from what is there by then rather than
                    // announcing everything written while it was being prepared.
                    continue;
                }
                if (announceBudget > 0) {
                    int sent = announceTranslations(ctx, id, written.keySet(), favouriters);
                    if (sent < 0) {
                        // Retryable refusal — see announceTranslations. Nothing about the next episode makes
                        // a rate limit less true, so the announcement half of this pass stops here while the
                        // stats half carries on.
                        announceBudget = 0;
                    } else if (sent > 0) {
                        announced += sent;
                        announceBudget--;
                    }
                }

                JsonNode ref = node.path("image").path("ref");
                JsonNode author = node.path("authorId");
                index.add(new IndexEntry(
                        id,
                        excerpt(markdown.stringValue()),
                        moment,
                        ref.isString() ? ref.stringValue() : null,
                        favouriters.size(),
                        author.isString() && !author.stringValue().isBlank() ? author.stringValue() : null));
            }
            mirrorTags(ctx, id, hasHighlight);
        }
        sweepOrphanedImages(ctx, referencedImages);
        ctx.logger().info(
                "recomputed highlight stats: {}/{} episodes highlighted ({} with a key moment, {} empty doc(s) pruned,"
                        + " {} favourite(s) across all visitors, {} translated into every content language,"
                        + " {} stranded translation(s), {} listener(s) told about a new translation)",
                highlighted, episodeIds.size() - quiet.size(), withMoment, pruned, totalFavourites, fullyTranslated, stranded,
                announced);
        ctx.store().put(Scope.site(), "stats",
                new HighlightStats(episodeIds.size() - quiet.size(), highlighted, withMoment, totalFavourites, fullyTranslated,
                        stranded));
        // Published after the prune above, so a doc removed in this pass never appears in the listing.
        ctx.store().put(Scope.site(), "index", new HighlightIndex(index));
    }

    /**
     * Machine-drafts the translations a podcaster has not written, into a document only the editor reads
     * (SDK 0.10.0/0.11.0, ARCHITECTURE §16, §12.7).
     *
     * <h2>Why a backend does this at all</h2>
     *
     * <p>The frontend has a translate button of its own, so this is not the only way to reach a provider —
     * it is the way that costs nothing at the moment somebody is waiting. A scheduled pass runs off the
     * request path, the host caches by text and provider, and the podcaster opens the editor to find the
     * suggestion already there. The browser call remains for text this pass has never seen, which is every
     * highlight in the minutes after it is written.
     *
     * <h2>Why it never writes the highlight</h2>
     *
     * <p>Because a translation nobody has read is not made safe by being automatic. The contract's rule is
     * that machine output is a draft; a scheduled job that wrote into {@code highlight.translations} would
     * publish prose to every reader of that language with no human anywhere in the loop, and would do it
     * again after each edit. {@link TranslationDrafts} is a separate, {@code backendOwned} document that the
     * edit modal offers and a visitor never sees.
     *
     * <h2>Three gates, and only one of them is this code's</h2>
     *
     * <p>{@code ctx.translation()} is {@code null} when the manifest omits {@code external.kinds:
     * ["translation"]} — which this plugin declares — or when the operator selected no provider, which is
     * every site by default. The two are deliberately indistinguishable, so the {@code null} check below is
     * not defensive coding but the ordinary path. {@code available()} is the second gate and is advisory
     * only: an admin can drop the provider between the check and the call, which is why the {@code catch}
     * exists as well. {@code external.usedBy} is the third and does <strong>not</strong> apply here — a
     * backend runs on a timer with no visitor and no role, so the declared kind is the whole server-side
     * gate.
     *
     * <p>{@link TranslationException} is <strong>checked</strong>, and that is the design: somebody else's
     * service refusing is a routine outcome, and the compiler is the cheapest place to find out that a
     * plugin has not decided what to do about it. This one gives up for the rest of the pass on anything
     * {@link TranslationException#retryable() retryable} — a rate limit or a saturated host does not become
     * untrue for the next episode, and hammering it is how a soft limit becomes a hard one.
     *
     * @param source        the highlight's default-locale markdown, and the thing being translated
     * @param written       the translations the podcaster has already written, keyed by locale
     * @param budget        how many provider calls this pass may still make
     * @return what remains of {@code budget}, or {@code 0} to stop the pass on a retryable refusal
     */
    private static int draftTranslations(PluginContext ctx, String episodeSlug, String source,
            Map<String, String> written, List<String> contentLocales, String defaultLocale, int budget) {
        Translation translation = ctx.translation();
        if (translation == null || !translation.available() || budget <= 0) {
            return budget;
        }
        List<TranslationDraft> drafts = new ArrayList<>();
        int remaining = budget;
        for (String locale : contentLocales) {
            if (locale.equals(defaultLocale) || written.containsKey(locale) || remaining <= 0) {
                continue;
            }
            try {
                // `Format.TEXT`, and the choice is not free: this field holds **markdown**, which is neither
                // of the two formats on offer. TEXT leaves the markup alone to be mangled predictably;
                // HTML would have the provider re-escape what it mistakes for entities. The honest
                // consequence is that this is a suggestion a human reads, not something to publish.
                TranslationResult result = translation.translate(
                        new TranslationRequest(source, defaultLocale, locale, TranslationRequest.Format.TEXT));
                drafts.add(new TranslationDraft(locale, result.text(), result.providerId(), source.hashCode()));
                remaining--;
            } catch (TranslationException e) {
                // reason(), not the message: matching on English is how a plugin breaks when the host
                // rewords a log line, and the enum is there precisely so a caller can tell "the admin has
                // configured nothing" from "try again in a minute".
                ctx.logger().warn("drafting {} for episode {} failed ({}): {}",
                        locale, episodeSlug, e.reason(), e.getMessage());
                if (e.retryable()) {
                    // Rate-limited, busy or timed out. Nothing about the next episode makes that less true,
                    // so the pass stops here and the schedule tries again on its own clock.
                    remaining = 0;
                } // else: this locale is simply not translatable right now — try the next one.
            }
        }
        if (drafts.isEmpty()) {
            // Nothing to say. A `put` of an empty list would still be a write, and would keep overwriting a
            // perfectly good set of drafts with nothing every time the budget ran out earlier in the pass.
            return remaining;
        }
        ctx.store().put(Scope.episode(episodeSlug), DRAFTS_KEY, new TranslationDrafts(drafts));
        return remaining;
    }

    /**
     * Tells everyone who favourited this episode's highlight that it now speaks a language it did not
     * before (SDK 0.14.0, ARCHITECTURE §17).
     *
     * <h2>Why this is the trigger</h2>
     *
     * <p>§17 was written for "a long-running thing a user took part in has finished", and in this plugin
     * that thing is a translation. A listener can only favourite a highlight that already exists — the star
     * button does not render without one — so "a highlight appeared for an episode you saved" is not a
     * state this plugin can reach. What it can reach is the podcaster saving German prose weeks after
     * somebody in Germany saved the English.
     *
     * <h2>Why the message carries every language at once</h2>
     *
     * <p>{@link NotifyMessage#text()} is a map of <em>finished sentences</em>, and this method fills it from
     * {@link #NOTIFY_TEMPLATES} rather than picking one. It is not an oversight that the recipient's
     * language is absent from this code: <strong>there is no way to learn it.</strong> {@link Notifier} has
     * no read side (§17.1) — a plugin cannot list an inbox, cannot count one, cannot ask what language
     * somebody reads in. And it should not matter, because a notification written on a timer is read days
     * later by somebody whose shell may have changed language since. Hand over all of them and let the
     * shell choose when it draws the bell.
     *
     * <h2>The three states, and only one of them sends</h2>
     *
     * <ul>
     *   <li><strong>No {@code announced} document</strong> — first sight of this episode. Record what it
     *       has and tell nobody. Treating an absent record as "nothing announced yet" would fire one
     *       notification per existing translation at every existing favouriter the moment this version is
     *       installed; see {@link AnnouncedLocales}.
     *   <li><strong>Recorded set equals the written set</strong> — nothing new. No write, no send.
     *   <li><strong>Written set has locales the record does not</strong> — the only case that notifies, and
     *       the record advances only once the host has accepted the send.
     * </ul>
     *
     * <h2>What the host enforces, and what this code must still handle</h2>
     *
     * <p>Eligibility is the host's and is satisfied by construction: a favouriter has a {@code USER}-scope
     * row, which is the same partition the host checks. But <strong>eligibility is not delivery</strong> —
     * {@link Notifier#send} answers <em>who was actually notified</em> rather than {@code void}, because an
     * account erased since the mark was written (§12.8) is the ordinary case and one stale participant must
     * not cost the others their notification. The difference is logged rather than treated as an error;
     * a write whose partial failure is invisible degrades in silence.
     *
     * <p>{@link NotificationException} is <strong>checked</strong>, for the reason
     * {@link TranslationException} is: a send refused by the operator's cap is a routine outcome, and the
     * compiler is the cheapest place to discover that a plugin has not decided what to do about it.
     * {@link NotificationException.Reason#RATE_LIMITED} is {@link NotificationException#retryable()}, so the
     * record is <em>not</em> advanced and the next tick tries the same episode again. The other two reasons
     * are bugs in this code that will fail identically next tick, so the record <em>is</em> advanced — a
     * plugin retrying a malformed link forever is a plugin nobody can drain.
     *
     * @param episodeSlug the episode whose highlight gained a language
     * @param written     the content locales the podcaster has actually written, already filtered through
     *                    {@code isContentLocale}
     * @param favouriters who to tell, host-resolved from their own partitions — see {@link #tallyFavourites}
     * @return how many listeners were told, {@code 0} when there was nothing to announce, or {@code -1} on
     *         a retryable refusal, which asks the caller to stop announcing for the rest of the pass
     */
    private static int announceTranslations(PluginContext ctx, String episodeSlug, Set<String> written,
            List<UUID> favouriters) {
        Notifier notifier = ctx.notifier();
        if (notifier == null) {
            // The manifest declares no `notifications` block. Same shape as `blobs`, `tags`, `identity` and
            // `translation`: an undeclared capability is null rather than a thrown error, so a fork of this
            // plugin that drops the block keeps working with this feature simply absent.
            return 0;
        }
        // TreeSet, so the stored document is stable across passes and a diff of two `announced` docs is
        // readable. Nothing depends on the order; a set that reshuffles itself on every write is just noise
        // in the store.
        Set<String> current = new TreeSet<>(written);
        Optional<AnnouncedLocales> record = ctx.store().get(Scope.episode(episodeSlug), ANNOUNCED_KEY,
                AnnouncedLocales.class);
        if (record.isEmpty()) {
            ctx.store().put(Scope.episode(episodeSlug), ANNOUNCED_KEY, new AnnouncedLocales(current));
            return 0;
        }
        Set<String> fresh = new TreeSet<>(current);
        fresh.removeAll(record.get().locales());
        if (fresh.isEmpty() || favouriters.isEmpty()) {
            if (!current.equals(new TreeSet<>(record.get().locales()))) {
                // Either something new arrived with nobody to tell, or a locale was withdrawn. Advance the
                // record anyway: a translation removed and re-added is not news, and leaving the withdrawn
                // one in the record would announce it a second time if it came back.
                ctx.store().put(Scope.episode(episodeSlug), ANNOUNCED_KEY, new AnnouncedLocales(current));
            }
            return 0;
        }
        NotifyMessage message = announcement(ctx, episodeSlug, fresh);
        try {
            List<UUID> told = notifier.send(favouriters, message);
            if (told.size() < favouriters.size()) {
                // Not an error, and worth a line anyway: this is what an erased or pseudonymised favouriter
                // looks like from here, and a plugin that never notices cannot tell "everyone was told" from
                // "the participant list went stale months ago".
                ctx.logger().info("announced {} for episode {} to {} of {} favouriter(s); the rest are no longer"
                        + " notifiable", String.join(", ", fresh), episodeSlug, told.size(), favouriters.size());
            }
            ctx.store().put(Scope.episode(episodeSlug), ANNOUNCED_KEY, new AnnouncedLocales(current));
            return told.size();
        } catch (NotificationException e) {
            // reason(), not the message: matching on English breaks the moment the host rewords a log line,
            // and the enum exists precisely so a caller can tell "hold this and try later" from "this will
            // never work".
            ctx.logger().warn("announcing {} for episode {} failed ({}): {}",
                    String.join(", ", fresh), episodeSlug, e.reason(), e.getMessage());
            if (e.retryable()) {
                return -1;
            }
            // A refused link or an over-long message is this plugin's bug and will be refused identically
            // next tick. Advance the record so the pass stops re-attempting it, and leave the warning above
            // as the thing an operator sees.
            ctx.store().put(Scope.episode(episodeSlug), ANNOUNCED_KEY, new AnnouncedLocales(current));
            return 0;
        }
    }

    /**
     * Builds the announcement, in every language {@link #NOTIFY_TEMPLATES} can say it.
     *
     * <p>The link is a subpath of this plugin's <em>own</em> {@code /p/sample/} subtree, which is one of the
     * two shapes the host will point a notification at (§17.1). An off-site link is refused, and rightly:
     * the bell is chrome the site is speaking through, and a plugin that could aim it anywhere could phish
     * the site's own users in the site's own voice.
     *
     * @param fresh the newly written locales, named to each reader in that reader's own language
     */
    private static NotifyMessage announcement(PluginContext ctx, String episodeSlug, Set<String> fresh) {
        String title = titleOf(ctx, episodeSlug);
        Map<String, String> text = new LinkedHashMap<>();
        NOTIFY_TEMPLATES.forEach((locale, template) -> text.put(locale,
                template.replace("{0}", title).replace("{1}", languageNames(ctx, fresh, locale))));
        return new NotifyMessage(text, HIGHLIGHT_SUBPATH_PREFIX + episodeSlug);
    }

    /**
     * Names a set of locales <em>in</em> a given language — "German" in the English sentence, "Deutsch" in
     * the German one.
     *
     * <p><strong>Per sentence, not once for the message</strong>, and the difference is visible: naming
     * every language by its endonym produced "now available in Deutsch" in the English text, which reads
     * like a bug to an English reader and is one. The whole point of {@link NotifyMessage} carrying a map
     * is that each entry is a finished sentence in <em>that</em> language, and a language name spliced into
     * it is part of the sentence.
     *
     * <p>{@link Locale#getDisplayLanguage(Locale)} is the JDK's own CLDR data, so this needs no table.
     * Where it has nothing — a content locale the JDK does not know, which an operator can perfectly well
     * add (§12.7 makes languages a runtime registry) — it falls back to the host's registered
     * {@link LocaleInfo#nativeName()} and then to the bare code, because a gap in the middle of a sentence
     * is worse than an endonym.
     *
     * @param codes    the locale codes to name
     * @param inLocale the language to name them in — the locale of the sentence being built
     */
    private static String languageNames(PluginContext ctx, Set<String> codes, String inLocale) {
        Map<String, String> registered = new HashMap<>();
        for (LocaleInfo info : ctx.locales().contentLocales()) {
            registered.put(info.code(), info.nativeName());
        }
        Locale reader = Locale.forLanguageTag(inLocale);
        return codes.stream().map(code -> {
            String name = Locale.forLanguageTag(code).getDisplayLanguage(reader);
            return name.isBlank() ? registered.getOrDefault(code, code) : name;
        }).collect(Collectors.joining(", "));
    }

    /**
     * Brings this plugin's tag subject for an episode into line with the episode's own tags (SDK 0.9.0,
     * ARCHITECTURE §6.1.1).
     *
     * <p><strong>What the shared vocabulary buys.</strong> Before it, a plugin that wanted tags invented a
     * private free-text column, so a wiki's {@code lore} and an episode's {@code lore} were unrelated
     * strings that could not be linked, suggested or counted together. Mirroring here means a visitor
     * filtering the feed by a tag and a visitor reading this plugin's page are looking at the same word.
     *
     * <p><strong>Reconcile, do not merely add.</strong> A tag the feed has since dropped is removed with
     * {@link Tags#untagSubject}, which is legitimate precisely because the subject is <em>this plugin's
     * own</em>: §6.1.1 forbids removing another writer's assignment, and nobody else writes here.
     * {@link Tags#tagSubject} is idempotent, so re-adding what is already there costs nothing.
     *
     * <p><strong>What this deliberately never calls is {@link Tags#tagEpisode}.</strong> Tagging an episode
     * changes the shell's filter options and what core recommends beside that episode — a capability, which
     * is why it needs a second manifest flag ({@code tags.writesEpisodes}) that this plugin does not ask
     * for. The sample reads the vocabulary and owns its own subjects; it does not classify episodes, so it
     * does not request the right to. Copying this file into a plugin that genuinely does classify them is
     * where that flag belongs — not here.
     *
     * @param episodeSlug  the episode whose tags to mirror
     * @param hasHighlight whether the episode still has a publishable highlight; {@code false} clears the
     *                     subject, so removing a highlight also retires the tags it carried
     */
    private static void mirrorTags(PluginContext ctx, String episodeSlug, boolean hasHighlight) {
        Tags tags = ctx.tags();
        if (tags == null) {
            // Null unless the manifest declares a `tags` block — and an operator may have withheld it on
            // their install. Same null-check posture as ctx.blobs() below; no vocabulary, nothing to mirror.
            return;
        }
        String subject = SUBJECT_KEY_PREFIX + episodeSlug;
        Set<String> wanted = hasHighlight ? Set.copyOf(tags.tagsOn(episodeSlug)) : Set.of();
        for (String mine : tags.tagsOnSubject(subject)) {
            if (!wanted.contains(mine)) {
                tags.untagSubject(subject, mine);
            }
        }
        for (String tag : wanted) {
            tags.tagSubject(subject, tag);
        }
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
     *
     * <p><strong>{@code imageSweep} decides whether this deletes or only reports.</strong> The manifest
     * declares it with an {@code options} set of exactly {@code delete} and {@code report}, which is the
     * difference between a closed set and a free-text box put at its sharpest: core refuses a value
     * outside the set at write time and refuses the manifest's own {@code default} at load, so an operator
     * cannot save {@code "reprot"}, be told it worked, and have this method go on deleting their files. It
     * is {@code editableBy: "admin"} rather than {@code podcaster} because deleting stored files is acting
     * on storage, not configuring a feature.
     */
    private static void sweepOrphanedImages(PluginContext ctx, Set<String> referenced) {
        var blobs = ctx.blobs();
        if (blobs == null) {
            // Null unless the manifest declares a `blobs` block — and an operator may refuse it on their
            // install even though this one declares it. No storage, nothing to sweep.
            return;
        }
        String mode = ctx.config().get("imageSweep", String.class, SWEEP_DELETE);
        if (!SWEEP_DELETE.equals(mode) && !SWEEP_REPORT.equals(mode)) {
            // `options` closes this door going forward, but it cannot un-store a value written before the
            // field declared one. Fall back to the *safe* branch rather than the default one: refusing to
            // delete on a value we do not understand costs storage, and the other way costs files. Warned
            // once per recompute — not once per scheduler tick — and it reports a state actively
            // preventing cleanup, so it is worth the line each pass.
            ctx.logger().warn("unrecognised imageSweep={}; reporting orphans instead of deleting them", mode);
            mode = SWEEP_REPORT;
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
        if (SWEEP_REPORT.equals(mode)) {
            // Name them, so the log is something an operator can act on — a count alone tells them a
            // number and nothing they can check. Nothing else on this platform collects orphans, so this
            // mode leaks storage by design; it exists to be switched on before a first sweep and off after.
            if (!orphans.isEmpty()) {
                ctx.logger().info("imageSweep=report: {} orphaned highlight image(s) left in place: {}",
                        orphans.size(), orphans);
            }
            return;
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
     * Every visitor's {@code fav:} marks, across all their {@code USER} partitions (SDK 0.16.0).
     *
     * <p>The one read in this plugin that crosses an ownership boundary, so the manifest declares it —
     * {@code "data": { "readsAllUsers": true }} — and {@code ctx.allUsers()} is {@code null} without that.
     * Until 0.16.0 it was {@code ctx.store().queryAcrossUsers(...)}, reachable by any plugin by merely existing;
     * now an operator can read off the manifest that this one tallies its visitors' favourites.
     *
     * <p>{@code null} here means the manifest and this code disagree, which is a bug to see, not a state to
     * degrade through: an empty tally would publish "nobody favourited anything" as if it were true.
     *
     * @throws IllegalStateException if the manifest no longer declares {@code data.readsAllUsers}
     */
    private static List<OwnedDocEntry> everyonesFavourites(PluginContext ctx) {
        CrossUserStore everyone = ctx.allUsers();
        if (everyone == null) {
            throw new IllegalStateException(
                    "plugin.json no longer declares data.readsAllUsers, which favourite counts need");
        }
        return everyone.query(FAVOURITE_KEY_PREFIX);
    }

    /**
     * Counts every visitor's {@code fav:<episodeSlug>} mark, keyed by episode slug.
     *
     * <p>{@link dev.mosaicast.plugin.api.CrossUserStore#query(String) ctx.allUsers().query(...)} is the backend's <em>only</em>
     * window onto {@code USER} partitions: {@code store().get(Scope.user(), …)} and friends throw
     * {@link UnsupportedOperationException}, because a scheduled task has no calling user and resolving
     * {@code "me"} without one would have to pick somebody. There is no HTTP surface for this method
     * either, so a visitor's request cannot reach another visitor's marks through it.
     *
     * <p>Each entry's {@link dev.mosaicast.plugin.api.OwnedDocEntry#userId() userId} is <em>kept</em>, and
     * it is the only kind of user id this plugin trusts: it is host-resolved from the partition the
     * document sits in, never a value a client supplied. That is what makes {@code excludedUserId},
     * {@link #exportUser(String)} and — since SDK 0.14.0 — {@link #announceTranslations} trustworthy.
     * Contrast {@link Highlight#authorId()}, which is prose a podcaster typed into a shared document.
     *
     * <p>The favouriter list doubles as the count: there is one mark per user per episode, so its size
     * <em>is</em> the number of distinct visitors.
     *
     * <p><strong>What this list is deliberately not used for.</strong> It is never published — not into
     * {@link FavouriteCount}, not into {@link HighlightIndex}, not anywhere a browser can read. A visitor's
     * mark lives at {@code data/user/me/fav:<slug>} precisely so that it is unreachable from any browser
     * but their own, and an "also favourited by" avatar row would undo that with the plugin's own hands.
     * Notifying somebody is not the same as naming them to a stranger: the host delivers to the addressee
     * and gives this plugin no read side at all (§17.1).
     *
     * @param excludedUserId a user whose marks must not be counted (SDK 0.9.0 account deletion, §12.8), or
     *                       {@code null} to count everyone
     * @return the favouriters of each episode that has any, keyed by episode slug
     */
    private static Map<String, List<UUID>> tallyFavourites(PluginContext ctx, UUID excludedUserId) {
        Map<String, List<UUID>> byEpisode = new HashMap<>();
        for (OwnedDocEntry entry : everyonesFavourites(ctx)) {
            if (excludedUserId != null && excludedUserId.equals(entry.userId())) {
                continue;
            }
            if (isWithdrawnMark(entry.value())) {
                continue;
            }
            String slug = entry.key().substring(FAVOURITE_KEY_PREFIX.length());
            if (!slug.isBlank()) {
                byEpisode.computeIfAbsent(slug, k -> new ArrayList<>()).add(entry.userId());
            }
        }
        return byEpisode;
    }

    /**
     * Whether a stored favourite mark means "not favourited".
     *
     * <p>An explicit {@code false} is "unfavourited but written, not deleted" — an older client, or a
     * failed delete. Counting mere presence would report a favourite the visitor removed, and exporting it
     * would hand them back a preference they had withdrawn.
     */
    private static boolean isWithdrawnMark(JsonNode value) {
        return value.isBoolean() && !value.booleanValue();
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
     *
     * <p>And only if the episode is public (SDK 0.18.0): a highlight prepared for a quiet planned episode is
     * not published by a sitemap entry, an OpenGraph card or a {@code hasRoute} answer — each would name an
     * episode the site is hiding. Checked here, per request, because the phase moves with the clock; see
     * {@link #isQuiet(PluginContext, String)}.
     */
    private static Optional<Highlight> publishableHighlight(PluginContext ctx, String slug) {
        return ctx.store()
                .get(Scope.episode(slug), "highlight", Highlight.class)
                .filter(highlight -> highlight.markdown() != null && !highlight.markdown().isBlank())
                .filter(highlight -> !isQuiet(ctx, slug));
    }

    /**
     * OpenGraph metadata for one highlight's deep link.
     *
     * <p><strong>{@link OgMeta#locale()} is deliberately left unset</strong> (SDK 0.12.0), which is the
     * 3-argument constructor and means "whatever the host resolved for this request". The component exists
     * for a page written in <em>one fixed</em> language — a German article that stays German for an English
     * visitor. This page is the opposite: since 2.14.0 {@code HighlightPage.tsx} renders whichever
     * translation the shell's locale selects, so {@code /p/sample/highlight/<slug>?lang=de} really is a
     * German page and the host's own resolved locale is already the right answer.
     *
     * <p><strong>Naming a locale here would contradict {@link #urls()} one line at a time.</strong> That
     * method declares an {@code hreflang} alternate saying a German version of this URL exists; a crawler
     * follows it and finds {@code og:locale=en_US} and {@code <html lang="en">} on the page the alternate
     * pointed at. Two claims about one URL, made by one plugin, disagreeing. Verified against a running
     * core, which is the only way this shows up — every unit test passes either way.
     *
     * <p><strong>What stays imperfect, and is the contract's to fix rather than this plugin's.</strong>
     * {@code metaFor} receives a subpath and nothing else, so the description below is always the
     * default-locale excerpt even when the request resolved to German. The title is the feed's and does not
     * vary, and the description is 160 characters of preview text — so the residue is small, and it is
     * strictly smaller than the contradiction the alternative buys. Resolving it properly needs the
     * requested locale in this signature; flagged upstream rather than worked around here.
     *
     * <p><strong>The byline is resolved here, per request, and never stored</strong> (SDK 0.13.0, §8.8).
     * See {@link #bylineOf}.
     *
     * @param subpath the path below {@code /p/sample/}; never {@code null}, empty at the plugin's root
     * @return share metadata, or empty for anything that is not a highlight with content
     */
    @Override
    public Optional<OgMeta> metaFor(String subpath) {
        PluginContext ctx = this.ctx;
        if (ctx == null || subpath == null || !subpath.startsWith(HIGHLIGHT_SUBPATH_PREFIX)) {
            return Optional.empty();
        }
        String slug = subpath.substring(HIGHLIGHT_SUBPATH_PREFIX.length());
        if (slug.isBlank()) {
            return Optional.empty();
        }
        return publishableHighlight(ctx, slug).map(highlight -> {
            DisplaySnapshot snapshot = ctx.feeds().display(slug);
            String description = bylineOf(ctx, highlight)
                    .map(name -> excerpt(highlight.markdown()) + " — " + name)
                    .orElseGet(() -> excerpt(highlight.markdown()));
            return new OgMeta(snapshot.title(), description, snapshot.artwork());
        });
    }

    /**
     * The display name behind a highlight's {@code authorId}, resolved at this moment (SDK 0.13.0, §8.8).
     *
     * <h2>Why a lookup and not a stored name</h2>
     *
     * <p>Because a display name copied into this plugin's own store outlives the rename meant to shed it and
     * the erasure meant to end it, and core cannot reach inside a plugin's documents to fix either — it
     * provisioned this plugin's storage without ever learning which field holds a person. The rule is
     * unenforceable, which is exactly why {@link Users} exists and why this method is three lines rather
     * than a column.
     *
     * <h2>Absent, not redacted</h2>
     *
     * <p>{@link Users#resolve} <em>omits</em> an id that is unknown, erased or pseudonymised (§12.8) rather
     * than returning a tombstone for it, so the result is not index-aligned with what was asked and may be
     * shorter. Here that means an empty {@link Optional} and an OpenGraph description with no byline —
     * the highlight outlives its author, which is the property §8.8 was written to give a leaderboard.
     * Matching on the returned {@link UserRef#id()} rather than on position is the habit that generalises;
     * {@code HighlightPage.tsx} does it over a whole listing in one call.
     *
     * @return the author's current display name, or empty when there is no {@code authorId}, no
     *         {@code identity} block in the manifest, or nobody left behind the id
     */
    private static Optional<String> bylineOf(PluginContext ctx, Highlight highlight) {
        Users users = ctx.users();
        if (users == null || highlight.authorId() == null || highlight.authorId().isBlank()) {
            // No `identity` block in the manifest, or a highlight written before 2.15.0. Both are ordinary.
            return Optional.empty();
        }
        UUID id;
        try {
            id = UUID.fromString(highlight.authorId());
        } catch (IllegalArgumentException e) {
            // `authorId` is client input in a shared-scope document (see Highlight), so this is a shape the
            // host never validated. Debug rather than warn: a malformed byline costs a reader nothing.
            ctx.logger().debug("episode highlight carries an authorId that is not a UUID; no byline");
            return Optional.empty();
        }
        return users.resolve(List.of(id)).stream()
                .filter(ref -> ref.id().equals(id))
                .map(UserRef::displayName)
                .findFirst();
    }

    /**
     * Every highlight that has content, each with the languages it can actually be read in.
     *
     * <p><strong>The {@code alternates} map is this plugin's half of core's {@code hreflang} groups</strong>
     * (SDK 0.12.0, ARCHITECTURE §6.6/§12.7). Core emits <em>no</em> alternates for a plugin entry unless the
     * plugin declares them, and deliberately so: it cannot read this plugin's documents, so assuming the
     * site's languages apply to them would be a guess published as a fact. An empty map — the 2-argument
     * {@link SitemapUrl} constructor, used below for an untranslated highlight — is exactly that
     * pre-0.12.0 behaviour, and is the honest answer when there is nothing to claim.
     *
     * <p><strong>Every value is {@code loc} itself</strong>, because this plugin renders one path per
     * language: {@code /p/sample/highlight/<slug>} serves German when the shell is German. A plugin with a
     * translated slug per language would map each locale to its own path instead — that is why the
     * component is a map of paths rather than a list of codes. The entry for {@code loc}'s <em>own</em>
     * language is mandatory (the constructor throws without it), and it is not redundancy: it is this
     * plugin naming the language of its own page, which the host has no way to know.
     *
     * @return one entry per publishable highlight, in feed order
     * @see #translationGroup for which locales are allowed into the group, and why the test is threefold
     */
    @Override
    public List<SitemapUrl> urls() {
        PluginContext ctx = this.ctx;
        if (ctx == null) {
            return List.of();
        }
        // Read once per pass, not per episode: a site's language lists are a runtime registry an admin edits
        // (§12.7), so they must not be cached across passes — but they cannot change *within* one either.
        String defaultLocale = ctx.locales().defaultLocale();
        Set<String> uiLocales = Set.copyOf(ctx.locales().available().stream().map(LocaleInfo::code).toList());

        List<SitemapUrl> entries = new ArrayList<>();
        for (String slug : ctx.feeds().episodesIn(Scope.site())) {
            Optional<Highlight> highlight = publishableHighlight(ctx, slug);
            if (highlight.isEmpty()) {
                continue;
            }
            String loc = "/p/sample/" + HIGHLIGHT_SUBPATH_PREFIX + slug;
            Map<String, String> group = translationGroup(ctx, highlight.get(), loc, defaultLocale, uiLocales);
            entries.add(group.isEmpty() ? new SitemapUrl(loc, null) : new SitemapUrl(loc, null, group));
        }
        return List.copyOf(entries);
    }

    /**
     * The languages one highlight may honestly be advertised in, as {@code locale code -> path}.
     *
     * <p><strong>Three tests, and skipping any one of them publishes a lie.</strong> An alternate tells a
     * crawler "there is a translation at this URL"; it is followed, and what comes back is checked.
     * <ol>
     *   <li><strong>The translation exists and has text.</strong> A tab the podcaster opened and left blank
     *       is not a translation, and the editor stores it either way.
     *   <li><strong>The locale is one this site authors content in</strong>
     *       ({@link dev.mosaicast.plugin.api.Locales#isContentLocale(String)}). These keys sit
     *       <em>inside</em> a JSON value, so the host's doc-key validation never saw them and nothing
     *       checked them on the way in — they are client input, exactly as
     *       {@link #recomputeHighlightStats(PluginContext)} treats them. A forged key is unreachable in the
     *       UI, which the frontend can afford to shrug at; a forged key in {@code sitemap.xml} is this
     *       plugin telling Google a language exists.
     *   <li><strong>The shell can render the locale</strong>
     *       ({@link dev.mosaicast.plugin.api.Locales#available()}). This is the one that looks redundant
     *       and is not, and it is the reason the two lists are separate at all: an operator can permit text
     *       to be <em>authored</em> in Dutch without offering a Dutch <em>UI</em>. There is no
     *       {@code ?lang=nl} on such a site — the URL would resolve to the default language — so an
     *       {@code nl} alternate points at a page that answers in English and contradicts its own
     *       {@code hreflang}. Core applies this same filter to its legal pages and explicitly does not
     *       apply it to a plugin's entries, because only the plugin knows which of its paths is which.
     * </ol>
     *
     * <p>The default locale's entry is added first and unconditionally — it is the one naming {@code loc}'s
     * own language, and the site default is always a UI language. A group with <em>only</em> that entry is
     * returned empty instead: "this page exists, in one language" is not a translation group, and saying so
     * costs a sitemap entry two lines to claim nothing.
     *
     * @param highlight     the highlight, whose {@code translations} keys are untrusted input
     * @param loc           this page's path — every value in the returned map, one path per language
     * @param defaultLocale the site's default content locale, i.e. the language {@code loc} is written in
     * @param uiLocales     the codes the shell can render, so a {@code ?lang=} exists for them
     * @return locale code → {@code loc}, or an empty map when there is nothing to declare
     */
    private static Map<String, String> translationGroup(PluginContext ctx, Highlight highlight, String loc,
            String defaultLocale, Set<String> uiLocales) {
        Map<String, String> group = new LinkedHashMap<>();
        group.put(defaultLocale, loc);
        highlight.translations().forEach((locale, translation) -> {
            if (translation == null || translation.markdown() == null || translation.markdown().isBlank()) {
                return;
            }
            if (!ctx.locales().isContentLocale(locale) || !uiLocales.contains(locale)) {
                return;
            }
            group.put(locale, loc);
        });
        // Handed over as the LinkedHashMap it was built in: SitemapUrl preserves iteration order, so the
        // default language leads the group in the emitted XML rather than landing wherever a hash put it.
        return group.size() > 1 ? group : Map.of();
    }

    /**
     * Whether this plugin renders anything at {@code subpath} — the host turns a {@code false} into a real
     * {@code 404} (SDK 0.9.1, ARCHITECTURE §6.6).
     *
     * <p><strong>The problem it solves.</strong> Declaring a {@code page} slot reserves
     * {@code /p/sample/*}, and until this interface existed <em>every</em> subpath under it answered
     * {@code 200}: a mistyped slug, a highlight deleted last year and {@code /p/sample/nonsense} all
     * rendered the plugin's not-found view inside a success. §6.6 rules that out for core's own routes —
     * "real HTTP 404s for unknown episodes/routes, no soft-404" — and the consequence of the exception was
     * a crawler indexing this plugin's typos. Core knows a {@code page} slot was declared; only the plugin
     * knows whether a subpath is a thing.
     *
     * <p><strong>Do not be tempted to reuse {@link #metaFor(String)} for this, and this class is the
     * example of why.</strong> {@code metaFor} answers empty for {@code moments}, {@code gallery} and
     * {@code unwritten} <em>on purpose</em> — they are views with nothing to describe to a link scraper —
     * so reading "no share metadata" as "no page" would 404 three working entrances straight out of
     * {@code nav[]}. {@code metaFor} says how to describe a page; this says whether it exists.
     *
     * <p><strong>It runs on a request</strong>, like {@link #search(String, Role, int)}: a lookup, not a
     * scan. {@link #publishableHighlight} is a single keyed read. A provider that throws is logged and
     * skipped and the route answers {@code 200} — a broken plugin must not turn a working page into a 404 —
     * so the failure is invisible from a visitor's side and only the tests will say.
     *
     * <p><strong>It decides the status line, not the body.</strong> The shell renders its own not-found
     * view; this plugin's page renders one too (its {@code matchRoute} miss branch), and the point of
     * answering here is that the two now agree.
     *
     * @param subpath the path below {@code /p/sample/}; <strong>empty at the plugin's own landing page</strong>
     * @return whether this plugin renders something there
     */
    @Override
    public boolean hasRoute(String subpath) {
        if (subpath == null) {
            return false;
        }
        if (!subpath.startsWith(HIGHLIGHT_SUBPATH_PREFIX)) {
            // The fixed entrances, including "" — see PAGE_SUBPATHS. Answerable without a context, which is
            // why this branch comes first: core may look an extension point up before register() has run.
            return PAGE_SUBPATHS.contains(subpath);
        }
        String slug = subpath.substring(HIGHLIGHT_SUBPATH_PREFIX.length());
        if (slug.isBlank()) {
            return false;   // `/p/sample/highlight/` names no episode; the index is at the root
        }
        PluginContext ctx = this.ctx;
        // A still-null ctx degrades to "renders something", i.e. the pre-0.9.1 behaviour. Guessing 404 from
        // a plugin that has not finished starting would hide real pages, and the failure would look like
        // the host's, not this plugin's.
        return ctx == null || publishableHighlight(ctx, slug).isPresent();
    }

    /**
     * This plugin's contribution to the site-wide search (SDK 0.9.0, ARCHITECTURE §6.7).
     *
     * <p><strong>Why a plugin should implement this.</strong> Core searched episodes and nothing else, so a
     * plugin with searchable content grew a second search box on the same site — right for its own data,
     * wrong for a visitor, who then had two places to type the same query. Results are <strong>grouped by
     * source, never merged</strong>: {@link SearchHit#score()} here and Postgres {@code ts_rank} are not on
     * one scale, so the host renders a section per source rather than interleaving them. Do not tune the
     * score expecting to outrank an episode; it orders this section only.
     *
     * <p><strong>Access is the plugin's job here — the one place in this contract where it is.</strong>
     * Everywhere else the host resolves access and the plugin consumes the result, but core has no model of
     * this plugin's objects and cannot know that {@code unwritten} is a podcaster's view. So the caller's
     * role arrives as a parameter and a provider that returns something the caller may not see has leaked
     * it, with nothing else to catch that. Note {@code role} is <strong>{@code null} for anonymous</strong>,
     * not a fourth enum constant — the mistake worth writing a test for, which
     * {@code SearchProviderHarness} does by calling every role including that one.
     *
     * <p>Concretely: highlights are {@code data.readableBy: anonymous}, so every caller gets those. The
     * "episodes with nothing written yet" hint is the {@code unwritten} entrance, which {@code nav[]} gates
     * to a podcaster, so only a podcaster or an admin is offered it.
     *
     * <p><strong>It runs on a request, with a budget</strong> (§6.7 — a section that misses its budget comes
     * back marked rather than dropped, which reads to a visitor as "did not answer"). This reads the one
     * {@code index} document {@link #recomputeHighlightStats} already publishes rather than walking every
     * episode's doc, which is what keeps it a lookup. Titles are resolved live through
     * {@link PluginContext#feeds()} and deliberately <em>not</em> cached into that index: a snapshot is
     * overwritten on every feed refetch (§4.2), and a copy kept beside the excerpt would be a second,
     * staler answer to a question the host already answers.
     *
     * <p><strong>The cost of that choice, stated plainly: results lag a new highlight</strong> by up to
     * {@code refreshIntervalMinutes}. Nothing notifies this backend when the frontend writes a highlight —
     * the doc store is an HTTP surface the plugin's own code does not sit in front of — so the index is
     * only as fresh as the last scheduled pass. The plugin's own page has exactly the same lag for exactly
     * the same reason, so at least the two agree. The alternative is walking every episode's document on
     * every keystroke-driven search, which is the scan §6.7 budgets against; a plugin that genuinely needs
     * search to be immediate wants {@code storage.schema} and its full-text index, not a faster scan.
     *
     * @param query the visitor's query
     * @param role  the caller's role, or {@code null} for an anonymous visitor
     * @param limit the most hits to return
     */
    @Override
    public List<SearchHit> search(String query, Role role, int limit) {
        PluginContext ctx = this.ctx;
        if (ctx == null || query == null || query.isBlank() || limit <= 0) {
            return List.of();
        }
        String needle = query.trim().toLowerCase(Locale.ROOT);
        List<IndexEntry> entries = ctx.store()
                .get(Scope.site(), "index", HighlightIndex.class)
                .map(HighlightIndex::entries)
                .orElse(List.of());

        List<SearchHit> hits = new ArrayList<>();
        Set<String> highlighted = new HashSet<>();
        for (IndexEntry entry : entries) {
            highlighted.add(entry.slug());
            if (hits.size() >= limit) {
                continue;   // keep collecting slugs for the podcaster hint below, stop adding results
            }
            boolean inSlug = entry.slug().toLowerCase(Locale.ROOT).contains(needle);
            boolean inText = entry.excerpt() != null && entry.excerpt().toLowerCase(Locale.ROOT).contains(needle);
            // The index is as old as the last pass, and an episode can have gone quiet since — a podcaster
            // moving its announcement later (SDK 0.18.0). Checked per hit, so only for what matched.
            if ((!inSlug && !inText) || isQuiet(ctx, entry.slug())) {
                continue;
            }
            // A slug match is the stronger signal; this orders *this* section and nothing else.
            hits.add(new SearchHit(
                    HIGHLIGHT_SUBPATH_PREFIX + entry.slug(),
                    titleOf(ctx, entry.slug()),
                    snippet(entry.excerpt()),
                    inSlug ? 1.0 : 0.5));
        }

        if (role == Role.PODCASTER || role == Role.ADMIN) {
            addUnwrittenHint(ctx, needle, highlighted, hits, limit);
        }
        return List.copyOf(hits);
    }

    /**
     * Offers the podcaster-only {@code unwritten} view when the query names an episode with no highlight.
     *
     * <p>Separate from {@link #search(String, Role, int)}'s main loop because it is the half whose
     * <em>visibility</em> differs, and keeping the role check at exactly one call site is what makes it
     * reviewable. An anonymous visitor never reaches this method, which
     * {@code SearchProviderHarness.leakedToAnonymous} asserts.
     */
    private static void addUnwrittenHint(PluginContext ctx, String needle, Set<String> highlighted,
            List<SearchHit> hits, int limit) {
        if (hits.size() >= limit) {
            return;
        }
        int unwritten = 0;
        for (String slug : ctx.feeds().episodesIn(Scope.site())) {
            if (!highlighted.contains(slug) && slug.toLowerCase(Locale.ROOT).contains(needle)) {
                unwritten++;
            }
        }
        if (unwritten == 0) {
            return;
        }
        // One hit for the view, not one per episode: the view is the destination, and a search section
        // filled with N rows that all open the same page is noise.
        hits.add(new SearchHit(
                PODCASTER_SUBPATH,
                "Highlights to write",
                unwritten + " episode(s) matching this have no highlight yet",
                0.25));
    }

    /**
     * The episode's feed title, falling back to its slug.
     *
     * <p>{@link dev.mosaicast.plugin.api.FeedAccess#display(String)} is documented never to return
     * {@code null}, but an episode can drop out of the feed between this plugin publishing its index and a
     * visitor searching. §6.7 skips a provider that throws — losing the whole section over one stale row is
     * a bad trade for a title, so this degrades instead.
     */
    private static String titleOf(PluginContext ctx, String slug) {
        try {
            DisplaySnapshot snapshot = ctx.feeds().display(slug);
            return snapshot.title() == null || snapshot.title().isBlank() ? slug : snapshot.title();
        } catch (RuntimeException e) {
            return slug;
        }
    }

    /** Trims an excerpt to one line's worth for a {@link SearchHit}. */
    private static String snippet(String excerpt) {
        if (excerpt == null) {
            return "";
        }
        return excerpt.length() <= SNIPPET_LENGTH ? excerpt : excerpt.substring(0, SNIPPET_LENGTH).trim() + "…";
    }

    /**
     * Repairs what this plugin derived from a departing account's data (SDK 0.9.0, ARCHITECTURE §12.8).
     *
     * <p><strong>What core already does, and why that is not enough.</strong> The {@code USER} scope is
     * host-owned, so core drops this visitor's {@code fav:<slug>} marks itself — those need no asking. What
     * it cannot do is repair the <em>three published documents that counted them</em>: every episode's
     * {@code favourites}, the site {@code stats} total, and each {@code index} entry's own count. Left
     * alone they would keep serving a deleted account's contribution until the next scheduled tick — up to
     * {@code refreshIntervalMinutes} of telling visitors a number that includes someone who asked to be
     * gone. That is §12's promise ("cut the identity link, aggregates stay correct") applied to the plugin
     * that actually holds the number.
     *
     * <p><strong>Why a whole recompute rather than three patches.</strong> Because three documents embed
     * the count, and patching each is three chances to disagree with the others. Republishing from the
     * store is one code path, already written and already tested. It is more work than an account deletion
     * strictly needs, and that is an acceptable trade for a rare operation that must not be subtly wrong.
     *
     * <p><strong>Why this is idempotent, which the contract requires.</strong> A failed erasure is
     * <em>retried</em>, so this may be called again on data it already handled. It does not decrement
     * anything; it recomputes from the current store while skipping this user, which yields the same answer
     * however many times it runs. {@code UserDataHandlerHarness.eraseTwice} is that test. Note handlers run
     * <strong>before</strong> core drops the account row, so the marks are still visible to
     * {@code allUsers().query(...)} at this moment — hence the filter rather than a plain re-tally.
     *
     * <p><strong>Throwing is the right answer to a failure.</strong> §12.8: the host writes a row per plugin
     * before it asks and leaves an <em>open record</em> on a failure rather than a log line, then retries
     * and surfaces it in admin. Swallowing an error to report success is the one thing this must not do, so
     * nothing here is wrapped in a {@code catch}.
     *
     * @param userId the departing user's id, as it appears in {@link OwnedDocEntry#userId()}
     */
    @Override
    public void eraseUser(String userId) {
        PluginContext ctx = this.ctx;
        if (ctx == null) {
            // Not registered — this plugin cannot honour the erasure, and saying so leaves the host's open
            // record to retry. Reporting success here is how data survives a deletion nobody notices.
            throw new IllegalStateException("sample plugin has no context yet; cannot erase derived counts");
        }
        recomputeHighlightStats(ctx, UUID.fromString(Objects.requireNonNull(userId, "userId")));
        // No user id in the log line: these are read by operators and sit beside core's own output.
        ctx.logger().info("republished favourite counts without a departing account's marks");
    }

    /**
     * This plugin's half of a data export (SDK 0.9.0, ARCHITECTURE §12.8).
     *
     * <p>Defaulted to empty on the interface so erasure could ship alone; overriding it is worth doing when
     * the plugin can say something core cannot. Here that is the <em>titles</em>: core owns the {@code USER}
     * scope and can dump {@code fav:the-kraken → true} on its own, but it does not know that {@code fav:} is
     * a key convention of this plugin's or that the rest of the key is an episode slug, so the readable
     * answer is this plugin's to produce.
     *
     * <p>Read-only and called independently of {@link #eraseUser(String)} — an export is a request in its
     * own right. Withdrawn marks are left out: handing someone back a preference they had removed would be
     * reporting something that is not true of them.
     *
     * @param userId the user's id
     * @return their favourited highlights, or empty when they have none
     */
    @Override
    public Optional<Map<String, Object>> exportUser(String userId) {
        PluginContext ctx = this.ctx;
        if (ctx == null) {
            return Optional.empty();
        }
        UUID id = UUID.fromString(Objects.requireNonNull(userId, "userId"));
        Set<String> inFeed = Set.copyOf(ctx.feeds().episodesIn(Scope.site()));
        List<Map<String, Object>> marks = new ArrayList<>();
        for (OwnedDocEntry entry : everyonesFavourites(ctx)) {
            if (!id.equals(entry.userId()) || isWithdrawnMark(entry.value())) {
                continue;
            }
            String slug = entry.key().substring(FAVOURITE_KEY_PREFIX.length());
            if (slug.isBlank()) {
                continue;
            }
            Map<String, Object> mark = new LinkedHashMap<>();
            mark.put("episode", slug);
            // Only for episodes still in the feed. A mark can outlive its episode, and inventing a title
            // for one that is gone would be worse than the slug the visitor's own URL used to carry.
            if (inFeed.contains(slug)) {
                mark.put("title", titleOf(ctx, slug));
            }
            marks.add(mark);
        }
        // The map is serialised by the host, so plain JSON-shaped values only.
        return marks.isEmpty() ? Optional.empty() : Optional.of(Map.of("favouritedHighlights", List.copyOf(marks)));
    }

    /**
     * Plain text for an OG description, a search snippet and the page listing: raw HTML and table rules out,
     * the most common markdown tokens stripped, whitespace collapsed. Approximately what the rendered page
     * says — the page itself goes through {@code ctx.sanitize}, this never renders as HTML anywhere.
     */
    static String excerpt(String markdown) {
        String text = HTML_NON_TEXT.matcher(markdown).replaceAll(" ");
        text = HTML_TAG.matcher(text).replaceAll(" ");
        text = TABLE_RULE.matcher(text).replaceAll("");
        String plain = WHITESPACE_RUN.matcher(MARKDOWN_TOKENS.matcher(text).replaceAll("")).replaceAll(" ").trim();
        return plain.length() <= DESCRIPTION_EXCERPT_LENGTH ? plain : plain.substring(0, DESCRIPTION_EXCERPT_LENGTH).trim() + "…";
    }
}
