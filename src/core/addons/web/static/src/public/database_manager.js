$(function() {
    // Little eye
    $('body').on('mousedown', '.o-little-eye', function (ev) {
        $(ev.target).closest('.input-group').find('.form-control').prop("type",
            (i, old) => { return old === "text" ? "password" : "text"; }
        );
    });
    // db modal
    $('body').on('click', '.o-database-action', function (ev) {
        ev.preventDefault();
        var db = $(ev.currentTarget).data('db');
        var target = $(ev.currentTarget).data('target');
        $(target).find('input[name=label]').val(db);
        $(target).modal();
    });
    // close modal on submit
    $('.modal').on('submit', 'form', function (ev) {
        var form = $(this).closest('form')[0];
        if (form && form.checkValidity && !form.checkValidity()) {
            return;
        }
        var modal = $(this).parentsUntil('body', '.modal');
        if (modal.hasClass('o-database-backup')) {
            $(modal).modal('hide');
            if (!$('.alert-backup-long').length) {
                $('.list-group').before("<div class='alert alert-info alert-backup-long'>The backup may take some time before being ready</div>");
            }
        }
    });

    // generate a random master password
    // removed l1O0 to avoid confusions
    var charset = "abcdefghijkmnpqrstuvwxyz23456789";
    var password = "";
    for (var i = 0, n = charset.length; i < 12; ++i) {
        password += charset.charAt(Math.floor(Math.random() * n));
        if (i === 3 || i === 7) {
            password += "-";
        }
    }
    var masterPwds = document.getElementsByClassName("generated-master-pwd");
    for (var i=0, len=masterPwds.length|0; i<len; i=i+1|0) {
        masterPwds[i].innerText = password;
    }
    var masterPwdInputs = document.getElementsByClassName("generated-master-pwd-input");
    for (var i=0, len=masterPwdInputs.length|0; i<len; i=i+1|0) {
        masterPwdInputs[i].value = password;
        masterPwdInputs[i].setAttribute('autocomplete', 'new-password');
    }
});
