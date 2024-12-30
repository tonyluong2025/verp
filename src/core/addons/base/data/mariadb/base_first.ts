import { _format } from "../../../../tools";

module.exports = (cr) => {
  const models = [
    {
      irActions: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      irActwindow: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      irActReportXml: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      irActionsUrl: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      irActionsServer: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      irActClient: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
      },
      resUsers: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        active: {
          type: 'BOOLEAN',
          defaultValue: true,
        },
        login: {
          type: 'VARCHAR(64)',
          allowNull: false,
          unique: true,
        },
        password: {
          type: 'VARCHAR(255)',
          defaultValue: null
        },
        // -- No FK references below, will be added later by ORM
        // -- (when the destination rows exist)
        companyId: {
          type: 'INTEGER'
        },
        partnerId: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE'
        }
      },
      resGroups: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false,
        }
      },
      irModuleCategory: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        createdUid: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE'
        },
        updatedAt: {
          type: 'DATE'
        },
        updatedUid: {
          type: 'INTEGER'
        },
        parentId: {
          type: 'INTEGER',
          references: { table: 'irModuleCategory' },
          ondelete: 'SET NULL',
          onupdate: 'CASCADE'
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false,
        }
      },
      irModuleModule: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        createdUid: {
          type: 'INTEGER',
        },
        createdAt: {
          type: 'DATE'
        },
        updatedAt: {
          type: 'DATE'
        },
        updatedUid: {
          type: 'INTEGER',
        },
        website: {
          type: 'VARCHAR(255)',
        },
        summary: {
          type: 'VARCHAR(255)',
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false,
        },
        author: {
          type: 'VARCHAR(255)',
        },
        icon: {
          type: 'VARCHAR(255)',
        },
        state: {
          type: 'VARCHAR(16)',
        },
        latestVersion: {
          type: 'VARCHAR(255)',
        },
        shortdesc: {
          type: 'VARCHAR(255)',
        },
        categoryId: {
          type: 'INTEGER',
          references: { table: 'irModuleCategory' },
          ondelete: 'SET NULL',
          onupdate: 'CASCADE'
        },
        description: {
          type: 'TEXT',
        },
        application: {
          type: 'BOOLEAN',
          defaultValue: false,
        },
        demo: {
          type: 'BOOLEAN',
          defaultValue: false,
        },
        web: {
          type: 'BOOLEAN',
          defaultValue: false,
        },
        license: {
          type: 'VARCHAR(32)',
        },
        sequence: {
          type: 'INTEGER',
          defaultValue: 100
        },
        autoInstall: {
          type: 'BOOLEAN',
          defaultValue: false,
        },
        toBuy: {
          type: 'BOOLEAN',
          defaultValue: false,
        }
      },
    },
    {
      irModuleModuleDependency: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        createdUid: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE'
        },
        updatedAt: {
          type: 'DATE'
        },
        updatedUid: {
          type: 'INTEGER'
        },
        label: {
          type: 'VARCHAR(255)'
        },
        moduleId: {
          type: 'INTEGER',
          references: { table: 'irModuleModule' },
          ondelete: 'CASCADE',
          onupdate: 'CASCADE'
        },
        autoInstallRequired: {
          type: 'BOOLEAN',
          defaultValue: true,
        }
      },
    },
    {
      irModelData: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        createdUid: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE',
          defaultValue: new Date()
        },
        updatedAt: {
          type: 'DATE',
          defaultValue: new Date()
        },
        updatedUid: {
          type: 'INTEGER'
        },
        noupdate: {
          type: 'BOOLEAN',
          defaultValue: false
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false
        },
        module: {
          type: 'VARCHAR(255)',
          allowNull: false
        },
        model: {
          type: 'VARCHAR(255)',
          allowNull: false
        },
        resId: {
          type: 'INTEGER'
        }
      },
      resCurrency: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false
        },
        symbol: {
          type: 'VARCHAR(255)',
          allowNull: false
        }
      },
      resCompany: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false
        },
        partnerId: {
          type: 'INTEGER'
        },
        currencyId: {
          type: 'INTEGER'
        },
        sequence: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE'
        }
      },
      resPartner: {
        id: {
          type: 'INTEGER',
          autoIncrement: true,
          primaryKey: true
        },
        label: {
          type: 'VARCHAR(255)',
          allowNull: false,
        },
        companyId: {
          type: 'INTEGER'
        },
        createdAt: {
          type: 'DATE'
        }
      }
    },
    {
      '#command': 'addConstraint',
      irModuleModule: {
        name: 'label_uniq',
        type: 'unique',
        fields: ['label']
      }
    },
  ];
  const data = [
    {resCurrency: {
      'id': 1, 'label': 'EUR', 'symbol': '€'
    }},
    "INSERT INTO `irModelData` (label, module, model, noupdate, `resId`) VALUES ('EUR', 'base', 'res.currency', true, 1) RETURNING id",
    "select setval(`resCurrency_id_seq`, 1)",
    {resCompany: {
      'id': 1, 'label': 'My Company', 'partnerId': 1, 'currencyId': 1
    }},
    {irModelData: {
      'label': 'mainCompany', 'module': 'base', 'model': 'res.company', 'noupdate': true, 'resId': 1
    }},
    `select setval('"resCompany_id_seq"', 1)`,
    {resPartner: {
      'id': 1, 'label': 'My Company', 'companyId': 1
    }},
    {irModelData: {
      'label': 'mainPartner', 'module': 'base', 'model': 'res.partner', 'noupdate': true, 'resId': 1
    }},
    `select setval('"resPartner_id_seq"', 1)`,
    {resUsers: {
      'id': 1, 'login': '__system__', 'password': null, 'active': false, 'partnerId': 1, 'companyId': 1
    }},
    {irModelData: {
      'label': 'userRoot', 'module': 'base', 'model': 'res.users', 'noupdate': true, 'resId': 1
    }},
    `select setval('"resUsers_id_seq"', 1)`,
    {resGroups: {
      'id': 1, 'label': 'Employee'
    }},
    {irModelData: {
      'label': 'groupUser', 'module': 'base', 'model': 'res.groups', 'noupdate': true, 'resId': 1
    }},
    `select setval('"resGroups_id_seq"', 1)`,
  ]

  return {
    models: models,
    data: data
  };
};