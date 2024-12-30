verp.define('point_of_sale.CategoryButton', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    class CategoryButton extends PosComponent {
        get imageUrl() {
            const category = this.props.category
            return `/web/image?model=pos.category&field=image128&id=${category.id}&updatedAt=${category.updatedAt}&unique=1`;
        }
    }
    CategoryButton.template = 'CategoryButton';

    Registries.Component.add(CategoryButton);

    return CategoryButton;
});
