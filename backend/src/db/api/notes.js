const db = require('../models');
const FileDBApi = require('./file');
const crypto = require('crypto');
const Utils = require('../utils');

const Sequelize = db.Sequelize;
const Op = Sequelize.Op;

module.exports = class NotesDBApi {
  static async create(data, options) {
    const currentUser = (options && options.currentUser) || { id: null };
    const transaction = (options && options.transaction) || undefined;

    const notes = await db.notes.create(
      {
        id: data.id || undefined,

        content: data.content || null,
        importHash: data.importHash || null,
        createdById: currentUser.id,
        updatedById: currentUser.id,
      },
      { transaction },
    );

    await notes.setLead(data.lead || null, {
      transaction,
    });

    await notes.setUser(data.user || null, {
      transaction,
    });

    return notes;
  }

  static async bulkImport(data, options) {
    const currentUser = (options && options.currentUser) || { id: null };
    const transaction = (options && options.transaction) || undefined;

    // Prepare data - wrapping individual data transformations in a map() method
    const notesData = data.map((item, index) => ({
      id: item.id || undefined,

      content: item.content || null,
      importHash: item.importHash || null,
      createdById: currentUser.id,
      updatedById: currentUser.id,
      createdAt: new Date(Date.now() + index * 1000),
    }));

    // Bulk create items
    const notes = await db.notes.bulkCreate(notesData, { transaction });

    // For each item created, replace relation files

    return notes;
  }

  static async update(id, data, options) {
    const currentUser = (options && options.currentUser) || { id: null };
    const transaction = (options && options.transaction) || undefined;

    const notes = await db.notes.findByPk(id, {}, { transaction });

    const updatePayload = {};

    if (data.content !== undefined) updatePayload.content = data.content;

    updatePayload.updatedById = currentUser.id;

    await notes.update(updatePayload, { transaction });

    if (data.lead !== undefined) {
      await notes.setLead(
        data.lead,

        { transaction },
      );
    }

    if (data.user !== undefined) {
      await notes.setUser(
        data.user,

        { transaction },
      );
    }

    return notes;
  }

  static async deleteByIds(ids, options) {
    const currentUser = (options && options.currentUser) || { id: null };
    const transaction = (options && options.transaction) || undefined;

    const notes = await db.notes.findAll({
      where: {
        id: {
          [Op.in]: ids,
        },
      },
      transaction,
    });

    await db.sequelize.transaction(async (transaction) => {
      for (const record of notes) {
        await record.update({ deletedBy: currentUser.id }, { transaction });
      }
      for (const record of notes) {
        await record.destroy({ transaction });
      }
    });

    return notes;
  }

  static async remove(id, options) {
    const currentUser = (options && options.currentUser) || { id: null };
    const transaction = (options && options.transaction) || undefined;

    const notes = await db.notes.findByPk(id, options);

    await notes.update(
      {
        deletedBy: currentUser.id,
      },
      {
        transaction,
      },
    );

    await notes.destroy({
      transaction,
    });

    return notes;
  }

  static async findBy(where, options) {
    const transaction = (options && options.transaction) || undefined;

    const notes = await db.notes.findOne({ where }, { transaction });

    if (!notes) {
      return notes;
    }

    const output = notes.get({ plain: true });

    output.lead = await notes.getLead({
      transaction,
    });

    output.user = await notes.getUser({
      transaction,
    });

    return output;
  }

  static async findAll(filter, options) {
    const limit = filter.limit || 0;
    let offset = 0;
    let where = {};
    const currentPage = +filter.page;

    offset = currentPage * limit;

    const orderBy = null;

    const transaction = (options && options.transaction) || undefined;

    let include = [
      {
        model: db.leads,
        as: 'lead',

        where: filter.lead
          ? {
              [Op.or]: [
                {
                  id: {
                    [Op.in]: filter.lead
                      .split('|')
                      .map((term) => Utils.uuid(term)),
                  },
                },
                {
                  name: {
                    [Op.or]: filter.lead
                      .split('|')
                      .map((term) => ({ [Op.iLike]: `%${term}%` })),
                  },
                },
              ],
            }
          : {},
      },

      {
        model: db.users,
        as: 'user',

        where: filter.user
          ? {
              [Op.or]: [
                {
                  id: {
                    [Op.in]: filter.user
                      .split('|')
                      .map((term) => Utils.uuid(term)),
                  },
                },
                {
                  firstName: {
                    [Op.or]: filter.user
                      .split('|')
                      .map((term) => ({ [Op.iLike]: `%${term}%` })),
                  },
                },
              ],
            }
          : {},
      },
    ];

    if (filter) {
      if (filter.id) {
        where = {
          ...where,
          ['id']: Utils.uuid(filter.id),
        };
      }

      if (filter.content) {
        where = {
          ...where,
          [Op.and]: Utils.ilike('notes', 'content', filter.content),
        };
      }

      if (filter.active !== undefined) {
        where = {
          ...where,
          active: filter.active === true || filter.active === 'true',
        };
      }

      if (filter.createdAtRange) {
        const [start, end] = filter.createdAtRange;

        if (start !== undefined && start !== null && start !== '') {
          where = {
            ...where,
            ['createdAt']: {
              ...where.createdAt,
              [Op.gte]: start,
            },
          };
        }

        if (end !== undefined && end !== null && end !== '') {
          where = {
            ...where,
            ['createdAt']: {
              ...where.createdAt,
              [Op.lte]: end,
            },
          };
        }
      }
    }

    const queryOptions = {
      where,
      include,
      distinct: true,
      order:
        filter.field && filter.sort
          ? [[filter.field, filter.sort]]
          : [['createdAt', 'desc']],
      transaction: options?.transaction,
      logging: console.log,
    };

    if (!options?.countOnly) {
      queryOptions.limit = limit ? Number(limit) : undefined;
      queryOptions.offset = offset ? Number(offset) : undefined;
    }

    try {
      const { rows, count } = await db.notes.findAndCountAll(queryOptions);

      return {
        rows: options?.countOnly ? [] : rows,
        count: count,
      };
    } catch (error) {
      console.error('Error executing query:', error);
      throw error;
    }
  }

  static async findAllAutocomplete(query, limit, offset) {
    let where = {};

    if (query) {
      where = {
        [Op.or]: [
          { ['id']: Utils.uuid(query) },
          Utils.ilike('notes', 'content', query),
        ],
      };
    }

    const records = await db.notes.findAll({
      attributes: ['id', 'content'],
      where,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      orderBy: [['content', 'ASC']],
    });

    return records.map((record) => ({
      id: record.id,
      label: record.content,
    }));
  }
};
