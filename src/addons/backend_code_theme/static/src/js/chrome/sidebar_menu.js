verp.define('backend_code_theme.SidebarMenu', function (require) {
    "use strict";


    //sidebar toggle effect
    $(document).on("click", "#closeSidebar", function(event){
        $("#closeSidebar").hide();
        $("#openSidebar").show();
    });
    $(document).on("click", "#openSidebar", function(event){
        $("#openSidebar").hide();
        $("#closeSidebar").show();
    });
    $(document).on("click", "#openSidebar", function(event){
        $("#sidebarPanel").css({'display':'block'});
        $(".o-action-manager").css({'margin-left': '200px','transition':'all .1s linear'});
        $(".top-heading").css({'margin-left': '200px','transition':'all .1s linear', 'width':'auto'});

        //add class in navbar
        var navbar = $(".o-main-navbar");
        var navbarId = navbar.data("id");
        $("nav").addClass(navbarId);
        navbar.addClass("small-nav");

        //add class in action-manager
        var actionManager = $(".o-action-manager");
        var actionManagerId = actionManager.data("id");
        $("div").addClass(actionManagerId);
        actionManager.addClass("sidebar-margin");

        //add class in top-heading
        var topHead = $(".top-heading");
        var topHeadId = topHead.data("id");
        $("div").addClass(topHeadId);
        topHead.addClass("sidebar-margin");
    });
    $(document).on("click", "#closeSidebar", function(event){
        $("#sidebarPanel").css({'display':'none'});
        $(".o-action-manager").css({'margin-left': '0px'});
        $(".top-heading").css({'margin-left': '0px', 'width':'100%'});

        //remove class in navbar
        var navbar = $(".o-main-navbar");
        var navbarId = navbar.data("id");
        $("nav").removeClass(navbarId);
        navbar.removeClass("small-nav");

        //remove class in action-manager
        var actionManager = $(".o-action-manager");
        var actionManagerId = actionManager.data("id");
        $("div").removeClass(actionManagerId);
        actionManager.removeClass("sidebar-margin");

        //remove class in top-heading
        var topHead = $(".top-heading");
        var topHeadId = topHead.data("id");
        $("div").removeClass(topHeadId);
        topHead.removeClass("sidebar-margin");
    });

    $(document).on("click", ".sidebar a", function(event){
        var menu = $(".sidebar a");
        var $this = $(this);
        var id = $this.data("id");
        $("header").removeClass().addClass(id);
        menu.removeClass("active");
        $this.addClass("active");

        //sidebar close on menu-item click
        $("#sidebarPanel").css({'display':'none'});
        $(".o-action-manager").css({'margin-left': '0px'});
        $(".top-heading").css({'margin-left': '0px', 'width':'100%'});
        $("#closeSidebar").hide();
        $("#openSidebar").show();

        //remove class in navbar
        var navbar = $(".o-main-navbar");
        var navbarId = navbar.data("id");
        $("nav").removeClass(navbarId);
        navbar.removeClass("small-nav");

        //remove class in action-manager
        var actionManager = $(".o-action-manager");
        var actionManagerId = actionManager.data("id");
        $("div").removeClass(actionManagerId);
        actionManager.removeClass("sidebar-margin");

        //remove class in top-heading
        var topHead = $(".top-heading");
        var topHeadId = topHead.data("id");
        $("div").removeClass(topHeadId);
        topHead.removeClass("sidebar-margin");
    });
});