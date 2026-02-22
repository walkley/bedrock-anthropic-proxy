# Bedrock Anthropic Proxy

将 AWS Bedrock API 转换为 Anthropic Messages API 兼容的代理服务。

## 架构

```
Client (Anthropic SDK) → API Gateway (streaming) → Lambda → Bedrock Runtime
```

认证透传：客户端发送的 Bedrock API Key 直接传递给 Bedrock Runtime 验证，Lambda 不存储任何密钥。

## 部署

```bash
sam build
sam deploy --guided
```

部署时可选提供 `HostedZoneId` 和 `DomainName` 参数来配置自定义域名（如 `anthropic.example.com`），会自动创建 ACM 证书和 Route 53 记录。

## 使用

`api_key` 填 [Bedrock API Key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)，`model` 使用 Bedrock inference profile ID。

使用自定义域名时，`base_url` 直接用域名：

```python
import anthropic

client = anthropic.Anthropic(
    api_key="your-bedrock-api-key",
    base_url="https://anthropic.example.com",
)
```

未配置自定义域名时，使用部署输出的 `ApiEndpoint`（注意包含 `/api` 路径前缀）：

```python
client = anthropic.Anthropic(
    api_key="your-bedrock-api-key",
    base_url="https://xxx.execute-api.us-west-2.amazonaws.com/api",
)
```

调用示例：

```python
# 非流式
response = client.messages.create(
    model="us.anthropic.claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)

# 流式
with client.messages.stream(
    model="us.anthropic.claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

`model` 字段直接透传给 Bedrock，支持所有 Bedrock 模型。可用的 inference profile ID 参考 [AWS 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)。
