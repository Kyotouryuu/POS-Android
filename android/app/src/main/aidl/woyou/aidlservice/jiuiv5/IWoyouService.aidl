package woyou.aidlservice.jiuiv5;

import woyou.aidlservice.jiuiv5.ICallback;

interface IWoyouService {
    void sendRAWData(in byte[] data, in ICallback callback);
}
