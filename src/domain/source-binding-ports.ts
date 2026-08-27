import type { Instant } from "./model.js";
import type { Actor } from "./control-plane.js";
import type { ChannelSourceBinding, StoredChannelSourceBinding } from "./source-binding.js";

/**
 * @deprecated Historical storage/migration compatibility only.
 *
 * New code must depend on DistributionConfigurationStorePort and DistributionRoute instead.
 * The mutating method remains implemented by the SQLite compatibility store so old migrations can
 * be opened and audited, but active Product Setup never calls it; SetupChannelRegistrationService
 * explicitly refuses legacy binding calls.
 */
export interface ChannelSourceBindingStorePort {
  bindChannelSource(
    binding: ChannelSourceBinding,
    now: Instant,
    actor: Actor
  ): { created: boolean; record: StoredChannelSourceBinding };
  getChannelSourceBinding(bindingId: string): StoredChannelSourceBinding | null;
  getChannelSourceBindingForAccount(accountId: string): StoredChannelSourceBinding | null;
  listChannelSourceBindings(): readonly StoredChannelSourceBinding[];
  listChannelSourceBindingsForFolder(folderId: string): readonly StoredChannelSourceBinding[];
}

/** Read-only subset allowed for migration/audit projections. */
export type LegacyChannelSourceBindingReadPort = Pick<
  ChannelSourceBindingStorePort,
  "getChannelSourceBinding" | "getChannelSourceBindingForAccount" | "listChannelSourceBindings" | "listChannelSourceBindingsForFolder"
>;
