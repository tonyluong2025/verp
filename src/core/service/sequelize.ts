import * as sequelize from '@sequelize/core';

export class DbService {}

export class Transaction extends sequelize.Transaction {}

export class Sequelize extends sequelize.Sequelize {};

export const ConnectionInfoFields = 'uri,database,dialect,username,password,host,port,ssl'.split(',');

export interface ConnectionInfo {
  uri: string,
  database: string,
  dialect?: any,
  username?: string,
  password?: string,
  host?: string,
  port?: number,
  ssl?: boolean
}

export const DataTypes = sequelize.DataTypes;

export const QueryTypes = sequelize.QueryTypes;
