import _ from "lodash";
import { registry } from "../../core";
import { _f, f, len, range } from "../../core/tools";
import { parseXml } from "../../core/tools/xml"

/**
 * Computes the valid iframe from given URL that can be embedded
        (or false in case of invalid URL).
 * @param videoUrl 
 * @returns 
 */
export function getVideoEmbedCode(videoUrl) {
    if (!videoUrl) {
        return false;
    }

    // To detect if we have a valid URL or not
    const validURLRegex = /^(http:\/\/|https:\/\/|\/\/)[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,5}(:[0-9]{1,5})?(\/.*)?$/g;

    // Regex for few of the widely used video hosting services
    const ytRegex = /^(?:(?:https?:)?\/\/)?(?:www\.)?(?:youtu\.be\/|youtube(-nocookie)?\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))((?:\w|-){11})(?:\S+)?$'/g;
    const vimeoRegex = /\/\/(player.)?vimeo.com\/([a-z]*\/)*([0-9]{6,11})[?]?.*/g;
    const dmRegex = /.+dailymotion.com\/(video|hub|embed)\/([^_?]+)[^#]*(#video=([^_&]+))?/g;
    const igRegex = /(.*)instagram.com\/p\/(.[a-zA-Z0-9]*)/g;
    const ykuRegex = /(.*).youku\.com\/(v_show\/id_|embed\/)(.+)/g;

    if (! videoUrl.match(validURLRegex)) {
        return false;
    }
    else {
        let embedUrl: any = false,
        ytMatch = videoUrl.match(ytRegex),
        vimeoMatch = videoUrl.match(vimeoRegex),
        dmMatch = videoUrl.match(dmRegex),
        igMatch = videoUrl.match(igRegex),
        ykuMatch = videoUrl.match(ykuRegex);

        if (ytMatch && len(ytMatch[1]) == 11) {
            embedUrl = f('//www.youtube%s.com/embed/%s?rel=0', ytMatch[0] || '', ytMatch[1]);
        }
        else if (vimeoMatch) {
            embedUrl = f('//player.vimeo.com/video/%s', vimeoMatch[2]);
        }
        else if (dmMatch) {
            embedUrl = f('//www.dailymotion.com/embed/video/%s', dmMatch[1]);
        }
        else if (igMatch) {
            embedUrl = f('//www.instagram.com/p/%s/embed/', igMatch[1]);
        }
        else if (ykuMatch) {
            let ykuLink = ykuMatch[2];
            if (ykuLink.includes('.html?')) {
                ykuLink = ykuLink.split('.html?')[0];
            }
            embedUrl = f('//player.youku.com/embed/%s', ykuLink);
        }
        else {
            // We directly use the provided URL as it is
            embedUrl = videoUrl;
        }
        return f('<iframe class="embed-responsive-item" src="%s" allowFullScreen="true" frameborder="0"></iframe>', embedUrl);
    }
}

/**
 *     Returns the plain non-tag text from an html

    :param html_fragment: document from which text must be extracted

    :return: text extracted from the html

 * @param htmlFragment 
 * @returns 
 */
export function textFromHtml(htmlFragment) {
    // lxml requires one single root element
    const tree = parseXml(f('<p>%s</p>', htmlFragment));
    return tree.toString();
}

/**
 * Returns a function that wraps SQL within unaccent if available
TODO remove when this tool becomes globally available

:param cr: cursor on which the wrapping is done

:return: function that wraps SQL with unaccent if available

 * @param cr 
 * @returns 
 */
export async function getUnaccentSqlWrapper(cr) {
    if ((await registry(cr.dbname)).hasUnaccent) {
        return (x) => _f("unaccent({wrappedSql})", {wrappedSql: x});
    }
    return (x) => x;
}

/**
 * Limited Levenshtein-ish distance (inspired from Apache text common)
    Note: this does not return quick results for simple cases (empty string, equal strings)
        those checks should be done outside loops that use this function.

    :param s1: first string
    :param s2: second string
    :param limit: maximum distance to take into account, return -1 if exceeded

    :return: number of character changes needed to transform s1 into s2 or -1 if this exceeds the limit
 * @param s1 
 * @param s2 
 * @param limit 
 * @returns 
 */
function distance(s1="", s2="", limit=4): number {
    const BIG: number = 100_000; // never reached integer
    if (s1.length > s2.length) {
        [s1, s2] = [s2, s1];
    }
    const l1 = s1.length;
    const l2 = s2.length;
    if (l2 - l1 > limit) {
        return -1;
    }
    const boundary = Math.min(l1, limit) + 1;
    let p = [];
    let d = [];
    for (const i of range(0, l1 + 1)) {
        p.push(i < boundary ? i : BIG);
        d.push(BIG);
    }
    for (const j of range(1, l2 + 1)) {
        const j2 = s2[j -1];
        d[0] = j;
        const rangeMin = Math.max(1, j - limit);
        const rangeMax = Math.min(l1, j + limit);
        if (rangeMin > 1) {
            d[rangeMin -1] = BIG;
        }
        for (const i of range(rangeMin, rangeMax + 1)) {
            if (s1[i - 1] == j2) {
                d[i] = p[i - 1];
            }
            else {
                d[i] = 1 + Math.min(d[i - 1], p[i], p[i - 1]);
            }
        }
        [p, d] = [d, p];
    }
    return p[l1] <= limit ? p[l1] : -1;
}

/**
 * Computes a score that describes how much two strings are matching.

    :param s1: first string
    :param s2: second string

    :return: float score, the higher the more similar
        pairs returning non-positive scores should be considered non similar
 * @param s1 
 * @param s2 
 * @returns 
 */
export function similarityScore(s1, s2) {
    const dist = distance(s1, s2);
    if (dist == -1) {
        return -1;
    }
    let score = _.intersection(s1, s2).length / s1.length;
    score -= dist / s1.length;
    score -= _.xor(s1, s2).length / (s1.length + s2.length)
    return score;
}