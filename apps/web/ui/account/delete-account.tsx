"use client";
import { useDeleteAccountModal } from "@/ui/modals/delete-account-modal";
import { Button, useTranslations } from "@dub/ui";

export default function DeleteAccountSection() {
  const t = useTranslations("partner");
  const { setShowDeleteAccountModal, DeleteAccountModal } =
    useDeleteAccountModal();

  return (
    <>
      <DeleteAccountModal />
      <div className="overflow-hidden rounded-xl border border-red-200 bg-white">
        <div className="flex flex-col space-y-1 p-6">
          <h2 className="text-base font-semibold">
            {t("account.deleteAccountTitle") || "Delete Account"}
          </h2>
          <p className="text-sm text-neutral-500">
            {t("account.deleteAccountWarning") ||
              "Permanently delete your account, all of your workspaces, links and their respective stats. This action cannot be undone - please proceed with caution."}
          </p>
        </div>
        <div className="border-b border-red-200" />

        <div className="flex items-center justify-start bg-red-50 px-6 py-3 sm:justify-end">
          <div>
            <Button
              text={
                t("account.deleteAccountButton") ||
                t("account.deleteAccountTitle") ||
                "Delete Account"
              }
              variant="danger"
              onClick={() => setShowDeleteAccountModal(true)}
            />
          </div>
        </div>
      </div>
    </>
  );
}
