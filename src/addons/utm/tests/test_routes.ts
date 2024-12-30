// import verp.tests

/*
@verp.tests.tagged('postInstall', '-atInstall')
class TestRoutes(verp.tests.HttpCase):

    test01WebSessionDestroy() {
        base_url = this.env.items('ir.config_parameter'].sudo().get_param('web.base.url')
        self.authenticate('demo', 'demo')
        res = self.opener.post(url=base_url + '/web/session/destroy', json={})
        self.assertEqual(res.status_code, 200)
    }
*/
export {}