import assert from "assert";
import { TransactionCase } from "../../../core/tests/common";

class TestIAP extends TransactionCase {
    async testGetAccount() {
        const account = await this.env.items("iap.account").get("randomServiceName");
        assert(await account.accountToken, "Must be able to read the field");
    }
}