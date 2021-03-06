import { MetadataStorage } from '../metadata';
import { AnyEntity, Dictionary, EntityMetadata, EntityProperty, FilterQuery, IPrimaryKey } from '../typings';
import { EntityIdentifier, wrap } from '../entity';
import { ChangeSet, ChangeSetType } from './ChangeSet';
import { QueryResult, Transaction } from '../connections';
import { Utils, ValidationError } from '../utils';
import { IDatabaseDriver } from '../drivers';

export class ChangeSetPersister {

  constructor(private readonly driver: IDatabaseDriver,
              private readonly identifierMap: Dictionary<EntityIdentifier>,
              private readonly metadata: MetadataStorage) { }

  async persistToDatabase<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, ctx?: Transaction): Promise<void> {
    const meta = this.metadata.get(changeSet.name);

    // process references first
    for (const prop of Object.values(meta.properties)) {
      this.processReference(changeSet, prop);
    }

    // persist the entity itself
    await this.persistEntity(changeSet, meta, ctx);
  }

  private async persistEntity<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, meta: EntityMetadata<T>, ctx?: Transaction): Promise<void> {
    let res: QueryResult | undefined;
    const wrapped = wrap(changeSet.entity, true);

    if (changeSet.type === ChangeSetType.DELETE) {
      await this.driver.nativeDelete(changeSet.name, wrapped.__primaryKey as Dictionary, ctx);
    } else if (changeSet.type === ChangeSetType.UPDATE) {
      res = await this.updateEntity(meta, changeSet, ctx);
      this.mapReturnedValues(changeSet.entity, res, meta);
    } else if (Utils.isDefined(wrapped.__primaryKey, true)) { // ChangeSetType.CREATE with primary key
      res = await this.driver.nativeInsert(changeSet.name, changeSet.payload, ctx);
      this.mapReturnedValues(changeSet.entity, res, meta);
      wrapped.__initialized = true;
    } else { // ChangeSetType.CREATE without primary key
      res = await this.driver.nativeInsert(changeSet.name, changeSet.payload, ctx);
      this.mapReturnedValues(changeSet.entity, res, meta);
      this.mapPrimaryKey(meta, res.insertId, changeSet);
      wrapped.__initialized = true;
    }

    await this.processOptimisticLock(meta, changeSet, res, ctx);
    changeSet.persisted = true;
  }

  private mapPrimaryKey<T>(meta: EntityMetadata<T>, value: IPrimaryKey, changeSet: ChangeSet<T>): void {
    const prop = meta.properties[meta.primaryKeys[0]];
    const insertId = prop.customType ? prop.customType.convertToJSValue(value, this.driver.getPlatform()) : value;
    const wrapped = wrap(changeSet.entity, true);
    wrapped.__primaryKey = Utils.isDefined(wrapped.__primaryKey, true) ? wrapped.__primaryKey : insertId;
    this.identifierMap[wrapped.__uuid].setValue(changeSet.entity[prop.name] as unknown as IPrimaryKey);
  }

  private async updateEntity<T extends AnyEntity<T>>(meta: EntityMetadata<T>, changeSet: ChangeSet<T>, ctx?: Transaction): Promise<QueryResult> {
    if (!meta.versionProperty || !changeSet.entity[meta.versionProperty]) {
      return this.driver.nativeUpdate(changeSet.name, wrap(changeSet.entity, true).__primaryKey as Dictionary, changeSet.payload, ctx);
    }

    const cond = {
      ...Utils.getPrimaryKeyCond<T>(changeSet.entity, meta.primaryKeys),
      [meta.versionProperty]: changeSet.entity[meta.versionProperty],
    } as FilterQuery<T>;

    return this.driver.nativeUpdate(changeSet.name, cond, changeSet.payload, ctx);
  }

  private async processOptimisticLock<T extends AnyEntity<T>>(meta: EntityMetadata<T>, changeSet: ChangeSet<T>, res: QueryResult | undefined, ctx?: Transaction) {
    if (meta.versionProperty && changeSet.type === ChangeSetType.UPDATE && res && !res.affectedRows) {
      throw ValidationError.lockFailed(changeSet.entity);
    }

    if (meta.versionProperty && [ChangeSetType.CREATE, ChangeSetType.UPDATE].includes(changeSet.type)) {
      const e = await this.driver.findOne<T>(meta.name, wrap(changeSet.entity, true).__primaryKey, {
        populate: [{
          field: meta.versionProperty,
        }] as unknown as boolean,
      }, ctx);
      (changeSet.entity as T)[meta.versionProperty] = e![meta.versionProperty];
    }
  }

  private processReference<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, prop: EntityProperty<T>): void {
    const value = changeSet.payload[prop.name];

    if (value as unknown instanceof EntityIdentifier) {
      changeSet.payload[prop.name] = value.getValue();
    }

    if (prop.onCreate && changeSet.type === ChangeSetType.CREATE) {
      changeSet.entity[prop.name] = changeSet.payload[prop.name] = prop.onCreate(changeSet.entity);

      if (prop.primary) {
        this.mapPrimaryKey(wrap(changeSet.entity, true).__meta, changeSet.entity[prop.name] as unknown as IPrimaryKey, changeSet);
      }
    }

    if (prop.onUpdate && changeSet.type === ChangeSetType.UPDATE) {
      changeSet.entity[prop.name] = changeSet.payload[prop.name] = prop.onUpdate(changeSet.entity);
    }
  }

  /**
   * Maps values returned via `returning` statement (postgres) or the inserted id (other sql drivers).
   * No need to handle composite keys here as they need to be set upfront.
   */
  private mapReturnedValues<T extends AnyEntity<T>>(entity: T, res: QueryResult, meta: EntityMetadata<T>): void {
    if (res.row && Object.keys(res.row).length > 0) {
      Object.values<EntityProperty>(meta.properties).forEach(prop => {
        if (prop.fieldNames && res.row![prop.fieldNames[0]] && !Utils.isDefined(entity[prop.name], true)) {
          entity[prop.name] = res.row![prop.fieldNames[0]];
        }
      });
    }
  }

}
