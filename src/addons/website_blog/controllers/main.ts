import { _Datetime, http } from "../../../core"
import { OrderedDict } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { bool, f, getLang, groupby, remove, setOptions, slug, sortedAsync, stringPart, timezone, toFormat, unslug } from "../../../core/tools";

// import re
// import theveb
// import itertools
// import pytz
// import babel.dates
// from collections import OrderedDict

// from odoo import http, fields
// from odoo.addons.http_routing.models.ir_http import slug, unslug
// from odoo.addons.website.controllers.main import QueryURL
// from odoo.addons.portal.controllers.portal import _build_url_w_params
// from odoo.http import request
// from odoo.osv import expression
// from odoo.tools import html2plaintext
// from odoo.tools.misc import get_lang
// from odoo.tools import sql

@http.define()
class WebsiteBlog extends http.Controller {
    static _module = module;
    
    static _blogPostPerPage = 12;  // multiple of 2,3,4
    static _postCommentPerPage = 10;

    get _blogPostPerPage() {
        return WebsiteBlog._blogPostPerPage;
    }

    get _postCommentPerPage() {
        return WebsiteBlog._postCommentPerPage;
    }

    async tagsList(req, tagIds, currentTag) {
        tagIds = Array.from(tagIds);  // required to avoid using the same list
        if (tagIds.includes(currentTag)) {
            remove(tagIds, currentTag);
        }
        else {
            tagIds.push(currentTag);
        }
        tagIds = (await req.getEnv()).items('blog.tag').browse(tagIds);
        return (await Promise.all(tagIds.map(async (tag) => slug([tag.id, await tag.seoName || await tag.displayName])))).join(',');
    }

    async navList(req, res, blog?: any) {
        let dom = blog && [['blogId', '=', blog.id]] || [];
        const env = await req.getEnv();
        if (!await (await env.user()).hasGroup('website.groupWebsiteDesigner')) {
            dom = dom.concat([['postDate', '<=', _Datetime.now()]]);
        }
        const groups = env.items('blog.post')._readGroupRaw(
            dom,
            ['label', 'postDate'],
            ["postDate"], {orderby: "postDate desc"});
        for (const group of groups) {
            const [r, label] = await group['postDate'];
            let [start, end] = r.split('/');
            group['postDate'] = label;
            group['dateBegin'] = start;
            group['dateEnd'] = end;

            const locale = await (await getLang(env)).code;
            start = _Datetime.toDatetime(start);
            const tz = timezone(req.context['tz'] ?? 'utc') || 'utc';

            group['month'] = toFormat(start, 'MMMM', {zone: tz, locale: locale});
            group['year'] = toFormat(start, 'yyyy', {zone: tz, locale: locale});
        }
        return new OrderedDict(Array.from(groupby(groups, g => g['year'])).map(([year, months]) => [year, [...months]]));
    }

    /**
     * Prepare all values to display the blogs index page or one specific blog
     * @param blogs 
     * @param blog 
     * @param dateBegin 
     * @param dateEnd 
     * @param tags 
     * @param state 
     * @param page 
     * @param search 
     */
    async _prepareBlogValues(req: WebRequest, res, blogs, opts: {blog?: any, dateBegin?: any, dateEnd?: any, tags?: any, state?: any, page?: any, search?: any}={}) {
        const {blog=false, dateBegin=false, dateEnd=false, tags=false, state=false, page=false, search} = opts;
        const env = await req.getEnv()
        const BlogPost = env.items('blog.post');
        const BlogTag = env.items('blog.tag');

        // prepare domain
        let domain = await req.website.websiteDomain();

        if (bool(blog)) {
            domain = domain.concat([['blogId', '=', blog.id]]);
        }

        if (dateBegin && dateEnd) {
            domain = domain.concat([["postDate", ">=", dateBegin], ["postDate", "<=", dateEnd]]);
        }
        const activeTagIds = tags && tags.split(',').map(tag => unslug(tag)[1]) || [];
        let activeTags = BlogTag;
        if (bool(activeTagIds)) {
            activeTags = await BlogTag.browse(activeTagIds).exists();
            const fixedTagSlug = (await Promise.all(activeTags.map(async (tag) => slug([tag.id, await tag.seoName || await tag.displayName])))).join(',');
            if (fixedTagSlug != tags) {
                const path = req.httpRequest.path;
                const newUrl = path.replace(f("/tag/%s", tags), fixedTagSlug && f("/tag/%s", fixedTagSlug) || "");
                if (newUrl != path) {  // check that really replaced and avoid loop
                    return req.redirect(res, newUrl, 301);
                }
            }
            domain = domain.concat([['tagIds', 'in', activeTags.ids]]);
        }

        let publishedCount, unpublishedCount;
        if (await (await env.user()).hasGroup('website.groupWebsiteDesigner')) {
            const countDomain = domain.concat([["websitePublished", "=", true], ["postDate", "<=", _Datetime.now()]]);
            publishedCount = await BlogPost.searchCount(countDomain);
            unpublishedCount = (await BlogPost.searchCount(domain)).sub(publishedCount);

            if (state === "published") {
                domain = domain.concat([["websitePublished", "=", true], ["postDate", "<=", _Datetime.now()]]);
            }
            else if (state === "unpublished") {
                domain = domain.concat(['|', ["websitePublished", "=", false], ["postDate", ">", _Datetime.now()]]);
            }
        }
        else {
            domain = domain.concat([["postDate", "<=", _Datetime.now()]]);
        }

        const useCover = await req.website.isViewActive('website_blog.optBlogCoverPost');
        const fullwidthCover = await req.website.isViewActive('website_blog.optBlogCoverPostFullwidthDesign');

        // if blog, we show blog title, if use_cover and not fullwidth_cover we need pager + latest always
        let offset = (page - 1) * this._blogPostPerPage
        if (!blog && useCover && !fullwidthCover && !tags && !dateBegin && !dateEnd && !search) {
            offset += 1;
        }

        const options = {
            'displayDescription': true,
            'displayDetail': false,
            'displayExtraDetail': false,
            'displayExtraLink': false,
            'displayImage': false,
            'allowFuzzy': !req.params['noFuzzy'],
            'blog': blog ? String(blog.id) : null,
            'tag': activeTags.ids.map(id => String(id)).join(','),
            'dateBegin': dateBegin,
            'date_end': dateEnd,
            'state': state,
        }
        const [total, details, fuzzySearchTerm] = await req.website._searchWithFuzzy("blogPostsOnly", search,
            {limit: page * this._blogPostPerPage, order: "isPublished desc, postDate desc, id asc", options: options});
        let posts = details[0]['results'] ?? BlogPost;
        let firstPost = BlogPost;
        // TODO adapt next line in master.
        if (bool(posts) && !bool(blog) && await posts[0].websitePublished && !search) {
            firstPost = posts[0];
        }
        posts = posts.slice(offset, offset + this._blogPostPerPage);

        const urlArgs = {}
        if (search) {
            urlArgs["search"] = search;
        }

        if (dateBegin && dateEnd) {
            urlArgs["dateBegin"] = dateBegin;
            urlArgs["dateEnd"] = dateEnd;
        }

        const pager = await req.website.pager({
            url: stringPart(req.httpRequest.pathname, '/page/')[0],
            total: total,
            page: page,
            step: this._blogPostPerPage,
            urlArgs: urlArgs,
        });

        let allTags;
        if (!bool(blogs)) {
            allTags = env.items('blog.tag');
        }
        else {
            allTags = !bool(blog) ? await blogs.allTags(true) : ((await blogs.allTags())[blog.id] ?? env.items('blog.tag'));
        }
        const tagCategory = await sortedAsync(await allTags.mapped('categoryId'), async (category) => (await category.label).toUpperCase());
        const otherTags = await sortedAsync(await allTags.filtered(x => !bool(await x.categoryId)), async (tag) => (await tag.label).toUpperCase());

        // for performance prefetch the first post with the others
        const postIds = firstPost.or(posts).ids;
        // and avoid accessing related blogs one by one
        const blogId = await posts.blogId;

        return {
            'dateBegin': dateBegin,
            'dateEnd': dateEnd,
            'firstPost': await firstPost.withPrefetch(postIds),
            'otherTags': otherTags,
            'tagCategory': tagCategory,
            'navList': await this.navList(req, res),
            'tagsList': this.tagsList,
            'pager': pager,
            'posts': await posts.withPrefetch(postIds),
            'tag': tags,
            'activeTagIds': activeTags.ids,
            'domain': domain,
            'stateInfo': state && {"state": state, "published": publishedCount, "unpublished": unpublishedCount},
            'blogs': blogs,
            'blog': blog,
            'search': fuzzySearchTerm || search,
            'searchCount': total,
            'originalSearch': fuzzySearchTerm && search,
        }
    }

    @http.route([
        '/blog',
        '/blog/page/<int:page>',
        '/blog/tag/<string:tag>',
        '/blog/tag/<string:tag>/page/<int:page>',
        '/blog/<model("blog.blog"):blog>',
        '/blog/<model("blog.blog"):blog>/page/<int:page>',
        '/blog/<model("blog.blog"):blog>/tag/<string:tag>',
        '/blog/<model("blog.blog"):blog>/tag/<string:tag>/page/<int:page>',
    ], {type: 'http', auth: "public", website: true, sitemap: true})
    async blog(req: WebRequest, res, opts: {blog?: any, tag?: any, page?: number=1, search?: any}={}) {
        const {blog, tag, page=1, search} = opts;
        const env = await req.getEnv();
        const Blog = env.items('blog.blog');

        // This is a fix for templates wrongly using the
        // 'blog_url' QueryURL which is defined below. Indeed, in the case where
        // we are rendering a blog page where no specific blog is selected we
        // define(d) that as `QueryURL('/blog', ['tag'], ...)` but then some
        // parts of the template used it like this: `blog_url(blog=XXX)` thus
        // generating an URL like "/blog?blog=blog.blog(2,)". Adding "blog" to
        // the list of params would not be right as would create "/blog/blog/2"
        // which is still wrong as we want "/blog/2". And of course the "/blog"
        // prefix in the QueryURL definition is needed in case we only specify a
        // tag via `blog_url(tab=X)` (we expect /blog/tag/X). Patching QueryURL
        // or making blog_url a custom function instead of a QueryURL instance
        // could be a solution but it was judged not stable enough. We'll do that
        // in master. Here we only support "/blog?blog=blog.blog(2,)" URLs.
        if isinstance(blog, str):
            blog = Blog.browse(int(re.search(r'\d+', blog)[0]))
            if not blog.exists():
                raise theveb.exceptions.NotFound()

        blogs = Blog.search(request.website.website_domain(), order="create_date asc, id asc")

        if not blog and len(blogs) == 1:
            url = QueryURL('/blog/%s' % slug(blogs[0]), search=search, **opt)()
            return request.redirect(url, code=302)

        date_begin, date_end, state = opt.get('date_begin'), opt.get('date_end'), opt.get('state')

        if tag and request.httprequest.method == 'GET':
            # redirect get tag-1,tag-2 -> get tag-1
            tags = tag.split(',')
            if len(tags) > 1:
                url = QueryURL('' if blog else '/blog', ['blog', 'tag'], blog=blog, tag=tags[0], date_begin=date_begin, date_end=date_end, search=search)()
                return request.redirect(url, code=302)

        values = self._prepare_blog_values(blogs=blogs, blog=blog, date_begin=date_begin, date_end=date_end, tags=tag, state=state, page=page, search=search)

        # in case of a redirection need by `_prepare_blog_values` we follow it
        if isinstance(values, theveb.wrappers.Response):
            return values

        if blog:
            values['main_object'] = blog
            values['edit_in_backend'] = true
            values['blog_url'] = QueryURL('', ['blog', 'tag'], blog=blog, tag=tag, date_begin=date_begin, date_end=date_end, search=search)
        else:
            values['blog_url'] = QueryURL('/blog', ['tag'], date_begin=date_begin, date_end=date_end, search=search)

        return request.render("website_blog.blog_post_short", values)

    @http.route(['''/blog/<model("blog.blog"):blog>/feed'''], type='http', auth="public", website=true, sitemap=true)
    def blog_feed(self, blog, limit='15', **kwargs):
        v = {}
        v['blog'] = blog
        v['base_url'] = blog.get_base_url()
        v['posts'] = request.env['blog.post'].search([('blog_id', '=', blog.id)], limit=min(int(limit), 50), order="post_date DESC")
        v['html2plaintext'] = html2plaintext
        r = request.render("website_blog.blog_feed", v, headers=[('Content-Type', 'application/atom+xml')])
        return r

    @http.route([
        '''/blog/<model("blog.blog"):blog>/post/<model("blog.post", "[('blog_id','=',blog.id)]"):blog_post>''',
    ], type='http', auth="public", website=true, sitemap=false)
    def old_blog_post(self, blog, blog_post, tag_id=None, page=1, enable_editor=None, **post):
        # Compatibility pre-v14
        return request.redirect(_build_url_w_params("/blog/%s/%s" % (slug(blog), slug(blog_post)), request.params), code=301)

    @http.route([
        '''/blog/<model("blog.blog"):blog>/<model("blog.post", "[('blog_id','=',blog.id)]"):blog_post>''',
    ], type='http', auth="public", website=true, sitemap=true)
    def blog_post(self, blog, blog_post, tag_id=None, page=1, enable_editor=None, **post):
        """ Prepare all values to display the blog.

        :return dict values: values for the templates, containing

         - 'blog_post': browse of the current post
         - 'blog': browse of the current blog
         - 'blogs': list of browse records of blogs
         - 'tag': current tag, if tag_id in parameters
         - 'tags': all tags, for tag-based navigation
         - 'pager': a pager on the comments
         - 'nav_list': a dict [year][month] for archives navigation
         - 'next_post': next blog post, to direct the user towards the next interesting post
        """
        BlogPost = request.env['blog.post']
        date_begin, date_end = post.get('date_begin'), post.get('date_end')

        domain = request.website.website_domain()
        blogs = blog.search(domain, order="create_date, id asc")

        tag = None
        if tag_id:
            tag = request.env['blog.tag'].browse(int(tag_id))
        blog_url = QueryURL('', ['blog', 'tag'], blog=blog_post.blog_id, tag=tag, date_begin=date_begin, date_end=date_end)

        if not blog_post.blog_id.id == blog.id:
            return request.redirect("/blog/%s/%s" % (slug(blog_post.blog_id), slug(blog_post)), code=301)

        tags = request.env['blog.tag'].search([])

        # Find next Post
        blog_post_domain = [('blog_id', '=', blog.id)]
        if not request.env.user.has_group('website.group_website_designer'):
            blog_post_domain += [('post_date', '<=', fields.Datetime.now())]

        all_post = BlogPost.search(blog_post_domain)

        if blog_post not in all_post:
            return request.redirect("/blog/%s" % (slug(blog_post.blog_id)))

        # should always return at least the current post
        all_post_ids = all_post.ids
        current_blog_post_index = all_post_ids.index(blog_post.id)
        nb_posts = len(all_post_ids)
        next_post_id = all_post_ids[(current_blog_post_index + 1) % nb_posts] if nb_posts > 1 else None
        next_post = next_post_id and BlogPost.browse(next_post_id) or false

        values = {
            'tags': tags,
            'tag': tag,
            'blog': blog,
            'blog_post': blog_post,
            'blogs': blogs,
            'main_object': blog_post,
            'nav_list': self.nav_list(blog),
            'enable_editor': enable_editor,
            'next_post': next_post,
            'date': date_begin,
            'blog_url': blog_url,
        }
        response = request.render("website_blog.blog_post_complete", values)

        if blog_post.id not in request.session.get('posts_viewed', []):
            if sql.increment_field_skiplock(blog_post, 'visits'):
                if not request.session.get('posts_viewed'):
                    request.session['posts_viewed'] = []
                request.session['posts_viewed'].append(blog_post.id)
                request.session.modified = true
        return response

    @http.route('/blog/<int:blog_id>/post/new', type='http', auth="user", website=true)
    def blog_post_create(self, blog_id, **post):
        # Use sudo so this line prevents both editor and admin to access blog from another website
        # as browse() will return the record even if forbidden by security rules but editor won't
        # be able to access it
        if not request.env['blog.blog'].browse(blog_id).sudo().can_access_from_current_website():
            raise theveb.exceptions.NotFound()

        new_blog_post = request.env['blog.post'].create({
            'blog_id': blog_id,
            'is_published': false,
        })
        return request.redirect("/blog/%s/%s?enable_editor=1" % (slug(new_blog_post.blog_id), slug(new_blog_post)))

    @http.route('/blog/post_duplicate', type='http', auth="user", website=true, methods=['POST'])
    def blog_post_copy(self, blog_post_id, **post):
        """ Duplicate a blog.

        :param blog_post_id: id of the blog post currently browsed.

        :return redirect to the new blog created
        """
        new_blog_post = request.env['blog.post'].with_context(mail_create_nosubscribe=true).browse(int(blog_post_id)).copy()
        return request.redirect("/blog/%s/%s?enable_editor=1" % (slug(new_blog_post.blog_id), slug(new_blog_post)))
