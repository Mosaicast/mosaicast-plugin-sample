// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

package dev.mosaicast.plugin.sample;

import dev.mosaicast.plugin.api.DisplaySnapshot;
import dev.mosaicast.plugin.api.DocEntry;
import dev.mosaicast.plugin.api.OgMeta;
import dev.mosaicast.plugin.api.PluginBackend;
import dev.mosaicast.plugin.api.PluginContext;
import dev.mosaicast.plugin.api.Scope;
import dev.mosaicast.plugin.api.ShareMetadataProvider;
import dev.mosaicast.plugin.api.SitemapProvider;
import dev.mosaicast.plugin.api.SitemapUrl;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
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
 *   <li><strong>Aggregate</strong> across scopes: {@link #register(PluginContext)} schedules a recurring
 *       recount of how many site episodes currently have a highlight, using {@link PluginContext#feeds()}
 *       + {@link PluginContext#store()}, storing the result at {@code Scope.site()}/{@code "stats"} for
 *       the site-scope Web Component to display.
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
 * call, exactly like PF4J does, which a same-instance test could never have caught.
 *
 * <p><strong>{@link PluginContext#schema()} is intentionally never called here.</strong> {@code
 * plugin.json} declares {@code "storage": "doc"}, and core's own 0.4.0 plan keeps {@code schema()}
 * returning {@code null} regardless of what a manifest declares — 0.4.0 explicitly allows that. There is
 * nothing to wire up until core ships schema storage; {@link #recomputeHighlightStats(PluginContext)}
 * below uses {@link dev.mosaicast.plugin.api.DocStore#query(Scope, String)} instead, this plugin's one use
 * of the Jackson-3-shaped {@link JsonNode} the doc store hands back from a prefix scan.
 */
@Extension
public class SamplePlugin implements PluginBackend, ShareMetadataProvider, SitemapProvider {

    /** Fallback used when the podcaster has not configured {@code refreshIntervalMinutes}. */
    static final int DEFAULT_REFRESH_MINUTES = 30;

    /** The deep-link subpath prefix this plugin serves: {@code /p/sample/highlight/<episodeSlug>}. */
    private static final String HIGHLIGHT_SUBPATH_PREFIX = "highlight/";

    /** Longest excerpt of a highlight's markdown carried into {@link OgMeta#description()}. */
    private static final int DESCRIPTION_EXCERPT_LENGTH = 160;

    /** Mirrors the frontend's stored highlight shape ({@code { markdown: string } }) at every scope. */
    record Highlight(String markdown) {
    }

    /** Mirrors the frontend's {@code stats} doc shape, read at {@code data/site/main/stats}. */
    record HighlightStats(int totalEpisodes, int highlightedEpisodes, int episodesWithMoment) {
    }

    /**
     * Set once by {@link #register(PluginContext)}; {@link ShareMetadataProvider}/{@link SitemapProvider}
     * have no {@code ctx} parameter of their own, so they reuse this. {@code static} (not a plain instance
     * field) because PF4J instantiates this class separately per extension-point lookup — see the class
     * javadoc for why an instance field silently doesn't work here.
     */
    private static volatile PluginContext ctx;

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
        ctx.onSchedule(interval, () -> recomputeHighlightStats(ctx));
    }

    private static void recomputeHighlightStats(PluginContext ctx) {
        List<String> episodeIds = ctx.feeds().episodesIn(Scope.site());
        int highlighted = 0;
        int withMoment = 0;
        for (String id : episodeIds) {
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
                    ctx.logger().warn("episode {} has a highlight doc with a missing/blank 'markdown' field; skipping it", id);
                    continue;
                }
                highlighted++;
                if (node.path("momentSeconds").isNumber()) {
                    withMoment++;
                }
            }
        }
        ctx.logger().info("recomputed highlight stats: {}/{} episodes highlighted ({} with a key moment)",
                highlighted, episodeIds.size(), withMoment);
        ctx.store().put(Scope.site(), "stats", new HighlightStats(episodeIds.size(), highlighted, withMoment));
    }

    @Override
    public Optional<OgMeta> metaFor(String subpath) {
        if (subpath == null || !subpath.startsWith(HIGHLIGHT_SUBPATH_PREFIX)) {
            return Optional.empty();
        }
        String slug = subpath.substring(HIGHLIGHT_SUBPATH_PREFIX.length());
        if (slug.isBlank()) {
            return Optional.empty();
        }
        return ctx.store().get(Scope.episode(slug), "highlight", Highlight.class).map(highlight -> {
            DisplaySnapshot snapshot = ctx.feeds().display(slug);
            return new OgMeta(snapshot.title(), excerpt(highlight.markdown()), snapshot.artwork());
        });
    }

    @Override
    public List<SitemapUrl> urls() {
        return ctx.feeds().episodesIn(Scope.site()).stream()
                .filter(slug -> ctx.store().get(Scope.episode(slug), "highlight", Highlight.class).isPresent())
                .map(slug -> new SitemapUrl("/p/sample/" + HIGHLIGHT_SUBPATH_PREFIX + slug, null))
                .toList();
    }

    /** Strips the most common markdown tokens and collapses whitespace, for a plain-text OG description. */
    private static String excerpt(String markdown) {
        String plain = markdown.replaceAll("[#*_`\\[\\]()]", "").replaceAll("\\s+", " ").trim();
        return plain.length() <= DESCRIPTION_EXCERPT_LENGTH ? plain : plain.substring(0, DESCRIPTION_EXCERPT_LENGTH).trim() + "…";
    }
}
