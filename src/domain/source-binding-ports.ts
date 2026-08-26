import type { Instant } from "./model.js";
import type { Actor } from "./control-plane.js";
import type { ChannelSourceBinding, StoredChannelSourceBinding } from "./source-binding.js";

export interface ChannelSourceBindingStorePort {
  /**
   * Binds a folder to an account. Re-binding the same account to a different folder is an
   * explicit update, not a second binding: the one-folder-per-account rule is enforced here
   * rather than left to callers.
   */
  bindChannelSource(
    binding: ChannelSourceBinding,
    now: Instant,
    actor: Actor
  ): { created: boolean; record: StoredChannelSourceBinding };
  getChannelSourceBinding(bindingId: string): StoredChannelSourceBinding | null;
  getChannelSourceBindingForAccount(accountId: string): StoredChannelSourceBinding | null;
  listChannelSourceBindings(): readonly StoredChannelSourceBinding[];
  /** Every account fed by this folder — the cross-posting case. */
  listChannelSourceBindingsForFolder(folderId: string): readonly StoredChannelSourceBinding[];
}
